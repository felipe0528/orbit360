// Original Orbit360 adapter. The Insta360 SDK is supplied separately by the user.
#include <Windows.h>
#include <cstdint>
#include <cstdlib>
#include <ins_stitcher.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <iostream>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
namespace {
std::mutex output_mutex;
std::atomic<bool> interrupted{false};
BOOL WINAPI control_handler(DWORD event) {
    if (event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT) {
        interrupted.store(true);
        return TRUE;
    }
    return FALSE;
}

std::string utf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (length == 0) throw std::runtime_error("Cannot encode a Windows path as UTF-8.");
    std::string result(length, '\0');
    WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
        static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
    return result;
}

std::string quote(const std::string& value) {
    static constexpr char hex[] = "0123456789abcdef";
    std::string result = "\"";
    for (const unsigned char c : value) {
        if (c == '"' || c == '\\') { result += '\\'; result += c; }
        else if (c < 0x20) { result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15]; }
        else result += c;
    }
    return result + '"';
}

void emit(const std::string& json) {
    std::lock_guard<std::mutex> lock(output_mutex);
    // Start a new line even when vendor progress logging ended with only '\r'.
    std::cout << ("\nORBIT360_JSON " + json + "\n") << std::flush;
}

std::int64_t number(const std::wstring& value, const std::string& name,
                    std::int64_t minimum, std::int64_t maximum) {
    std::size_t end = 0;
    std::int64_t result;
    try { result = std::stoll(value, &end); }
    catch (...) { throw std::runtime_error(name + " must be an integer."); }
    if (end != value.size() || result < minimum || result > maximum)
        throw std::runtime_error(name + " is outside its allowed range.");
    return result;
}

struct Options {
    std::vector<std::string> inputs;
    fs::path output, sdk_root, models;
    int width = 3840, height = 1920, timeout = 7200;
    std::int64_t bitrate = 0;
    bool flowstate = true, direction_lock = false, h265 = false, software = false;
    ins::STITCH_TYPE stitch_type = ins::STITCH_TYPE::OPTFLOW;
};

Options parse(int argc, wchar_t** argv) {
    Options options;
    for (int i = 1; i < argc; ++i) {
        const std::wstring arg = argv[i];
        if (i + 1 >= argc) throw std::runtime_error("Missing value for " + utf8(arg));
        const std::wstring value = argv[++i];
        const auto flag = [&] { return number(value, utf8(arg), 0, 1) != 0; };
        if (arg == L"--input") {
            const auto path = fs::absolute(value);
            if (!fs::is_regular_file(path)) throw std::runtime_error("Input file does not exist: " + utf8(value));
            options.inputs.push_back(path.u8string());
        } else if (arg == L"--output") options.output = fs::absolute(value);
        else if (arg == L"--sdk-root") options.sdk_root = fs::absolute(value);
        else if (arg == L"--models") options.models = fs::absolute(value);
        else if (arg == L"--width") options.width = static_cast<int>(number(value, "width", 128, 16384));
        else if (arg == L"--height") options.height = static_cast<int>(number(value, "height", 64, 8192));
        else if (arg == L"--bitrate") options.bitrate = number(value, "bitrate (bits/s)", 100000, 1000000000);
        else if (arg == L"--timeout-seconds") options.timeout = static_cast<int>(number(value, "timeout", 1, 86400));
        else if (arg == L"--flowstate") options.flowstate = flag();
        else if (arg == L"--direction-lock") options.direction_lock = flag();
        else if (arg == L"--h265") options.h265 = flag();
        else if (arg == L"--software-codecs") options.software = flag();
        else if (arg == L"--stitch-type") {
            if (value == L"template") options.stitch_type = ins::STITCH_TYPE::TEMPLATE;
            else if (value == L"optflow") options.stitch_type = ins::STITCH_TYPE::OPTFLOW;
            else if (value == L"dynamicstitch") options.stitch_type = ins::STITCH_TYPE::DYNAMICSTITCH;
            else if (value == L"aistitch") options.stitch_type = ins::STITCH_TYPE::AIFLOW;
            else throw std::runtime_error("Unknown stitch type.");
        } else throw std::runtime_error("Unknown argument: " + utf8(arg));
    }
    if (options.inputs.empty() || options.inputs.size() > 2 || options.output.empty())
        throw std::runtime_error("Supply one or two --input paths and one --output path.");
    if (options.output.extension() != L".mp4") throw std::runtime_error("Output must have the .mp4 extension.");
    if (fs::exists(options.output)) throw std::runtime_error("Output already exists; overwriting is disabled.");
    if (!fs::is_directory(options.output.parent_path())) throw std::runtime_error("Output parent directory does not exist.");
    if (options.width != 2 * options.height || options.height % 2)
        throw std::runtime_error("Panoramic output must be 2:1 with even dimensions.");
    if (options.direction_lock && !options.flowstate) throw std::runtime_error("Direction lock requires FlowState.");
    if (options.sdk_root.empty()) {
        wchar_t* value = nullptr;
        std::size_t length = 0;
        _wdupenv_s(&value, &length, L"INSTA360_MEDIA_SDK");
        if (value) { options.sdk_root = fs::absolute(value); free(value); }
    }
    if (options.sdk_root.empty()) throw std::runtime_error("Supply --sdk-root or INSTA360_MEDIA_SDK.");
    if (!fs::is_regular_file(options.sdk_root / "bin" / "MediaSDK.dll"))
        throw std::runtime_error("MediaSDK.dll not found under the supplied SDK root.");
    if (options.models.empty()) options.models = options.sdk_root / "bin" / "models";
    if (!fs::is_directory(options.models)) throw std::runtime_error("SDK model directory does not exist.");
    return options;
}

int stitch(const Options& options) {
    SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    const auto bin = options.sdk_root / "bin";
    const auto cookie = AddDllDirectory(bin.c_str());
    if (!cookie) throw std::runtime_error("Cannot register the private SDK DLL directory.");
    // Preload from a fully qualified trusted user-configured directory; do not use current-directory DLL lookup.
    const auto module = LoadLibraryExW((bin / "MediaSDK.dll").c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!module) throw std::runtime_error("Cannot load the SDK or its dependencies; Windows error " + std::to_string(GetLastError()));
    // Keep the DLL and its search directory alive until process exit (SDK worker teardown may use both).
    ins::InitEnv();
    ins::SetLogLevel(ins::InsLogLevel::ERR);
    ins::SetModelFileRootDir(options.models.u8string() + "/");
    emit("{\"event\":\"started\",\"sdkVersion\":" + quote(ins::GetVersion()) + "}");
    ins::MediaFileInfo info{};
    if (!ins::GetMediaFileInfo(options.inputs, info)) {
        emit("{\"event\":\"error\",\"message\":\"SDK could not parse input media.\"}");
        return 3;
    }
    emit("{\"event\":\"media\",\"width\":" + std::to_string(info.width) +
         ",\"height\":" + std::to_string(info.height) + ",\"durationMs\":" + std::to_string(info.duration_ms) + "}");
    int result = 0;
    // Shared callback state outlives the stitcher and its worker teardown.
    std::mutex state_mutex;
    std::condition_variable changed;
    bool finished = false, failed = false;
    {
        ins::VideoStitcher stitcher;
        stitcher.SetInputPath(options.inputs);
        stitcher.SetOutputPath(options.output.u8string());
        stitcher.SetOutputSize(options.width, options.height);
        if (options.bitrate) stitcher.SetOutputBitRate(options.bitrate);
        stitcher.SetStitchType(options.stitch_type);
        stitcher.SetCameraAccessoryType(ins::CameraAccessoryType::kAutoDetect);
        stitcher.EnableFlowState(options.flowstate);
        stitcher.EnableDirectionLock(options.direction_lock);
        stitcher.EnableH265Encoder(options.h265);
        stitcher.SetSoftwareCodecUsage(options.software, options.software);
        stitcher.SetStitchProgressCallback([&](int progress, int error) {
            // The supplied public API has no separate wait/finalized operation.
            // Its official example uses 100 as completion; caller FFprobe verification remains required.
            { std::lock_guard<std::mutex> guard(state_mutex); finished = progress >= 100; failed = failed || error != 0; }
            emit("{\"event\":\"progress\",\"percent\":" + std::to_string(progress) + "}");
            changed.notify_one();
        });
        stitcher.SetStitchStateCallback([&](int error, const char* message) {
            if (error == 0) return;
            { std::lock_guard<std::mutex> guard(state_mutex); failed = true; }
            emit("{\"event\":\"error\",\"code\":" + std::to_string(error) +
                ",\"message\":" + quote(message ? message : "SDK error") + "}");
            changed.notify_one();
        });
        SetConsoleCtrlHandler(control_handler, TRUE);
        stitcher.StartStitch();
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(options.timeout);
        std::unique_lock<std::mutex> lock(state_mutex);
        while (!finished && !failed && !interrupted.load() && std::chrono::steady_clock::now() < deadline)
            changed.wait_for(lock, std::chrono::milliseconds(250));
        if (failed) result = 4;
        else if (interrupted.load()) result = 130;
        else if (!finished) result = 124;
        lock.unlock();
        if (result) stitcher.CancelStitch();
        else {
            std::string features = "{\"event\":\"features\",\"values\":{";
            bool first = true;
            for (const auto& pair : stitcher.GetFeatureStatusMap()) {
                if (!first) features += ',';
                features += quote(pair.first) + ':' + std::to_string(pair.second);
                first = false;
            }
            emit(features + "}}");
        }
    }
    SetConsoleCtrlHandler(control_handler, FALSE);
    if (!result && (!fs::is_regular_file(options.output) || fs::file_size(options.output) == 0)) result = 5;
    if (result) {
        std::error_code ignored;
        fs::remove(options.output, ignored); // The path did not exist before this job.
        emit("{\"event\":\"error\",\"exitCode\":" + std::to_string(result) + "}");
    } else emit("{\"event\":\"completed\",\"output\":" + quote(options.output.u8string()) + "}");
    return result;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && (std::wstring(argv[1]) == L"--help" || std::wstring(argv[1]) == L"-h")) {
        std::cout << "Orbit360 stitch bridge (Windows x64)\n"
            "Required: --input FILE [--input SECOND_LENS] --output NEW.mp4 --sdk-root DIRECTORY\n"
            "Options: --width 3840 --height 1920 --flowstate 1 --direction-lock 0\n"
            "         --models DIRECTORY --bitrate BITS_PER_SECOND --h265 0\n"
            "         --stitch-type optflow|template|dynamicstitch|aistitch\n"
            "         --software-codecs 0 --timeout-seconds 7200\n"
            "SDK root may instead be supplied as INSTA360_MEDIA_SDK.\n"
            "Events use the prefix ORBIT360_JSON followed by one JSON object.\n"
            "Exit: 0 success; 2 arguments/load; 3 media; 4 SDK; 5 output; 124 timeout; 130 cancelled.\n";
        return 0;
    }
    try { return stitch(parse(argc, argv)); }
    catch (const std::exception& error) {
        emit("{\"event\":\"error\",\"message\":" + quote(error.what()) + "}");
        return 2;
    }
}
