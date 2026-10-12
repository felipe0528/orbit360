# Experimental native MediaSDK adapter

This is original C++17 code using the documented public MediaSDK 3.1.5 interface. Obtain the proprietary Windows x64 SDK separately. No vendor headers, libraries, models, or sample source are included in this repository.

The application can use the user's `MediaSDKTest.exe` immediately after `scripts/setup-sdk.ps1`. Building this adapter additionally requires Visual Studio Build Tools with the C++ desktop workload and CMake:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-native.ps1 -SdkRoot 'C:\private\MediaSDK'
.\.local\native-build\Release\orbit360-stitch.exe --help
```

Run one native process per export. Supply both matching lens files for recordings that use a two-file pair; a single dual-track file is passed only once.

```powershell
.\.local\native-build\Release\orbit360-stitch.exe `
  --sdk-root 'C:\private\MediaSDK' `
  --input 'D:\camera\VID_example_00_001.insv' `
  --input 'D:\camera\VID_example_10_001.insv' `
  --output 'D:\exports\new-panorama.mp4' `
  --width 3840 --height 1920 --flowstate 1 --direction-lock 0
```

`--sdk-root` identifies the directory containing `bin`, `lib`, and `include`. The equivalent environment variable is `INSTA360_MEDIA_SDK`. Runtime DLLs load from that private directory. `--models` overrides `bin/models`. Model paths passed to the SDK have the required trailing separator. Bitrate is left to SDK defaults unless explicitly requested in bits per second.

The adapter refuses to overwrite existing files. Its events are lines beginning with `ORBIT360_JSON ` followed by a JSON object; the SDK may emit other diagnostic text to the same stream. Events include `started`, `media`, `progress`, `features`, `completed`, and `error`. The feature event reports the SDK's actual runtime statuses; requesting FlowState is not a guarantee that every input can use it. Native timeouts default to two hours and are configurable up to 24 hours.

Exit codes: `0` completed, `2` argument/loading exception, `3` unreadable media, `4` SDK error, `5` missing output, `124` timeout, `130` console cancellation. Parent processes must additionally inspect output with `ffprobe` before accepting an export. Forced termination cannot run cleanup; keep intermediate outputs in a dedicated job directory.

The output is an equirectangular panorama. Reframing, timeline cuts, and final composition are performed separately using FFmpeg. This adapter does not automate or modify Insta360 Studio.

Validation status: the public SDK headers and Windows import library were inspected. Real ONE X2, X3 and X4 INSV samples were stitched successfully by the vendor's private sample with FlowState and checked with FFprobe. See [validation details](../docs/validation.md). The original native adapter has not been compiled on the development machine because MSVC/CMake are unavailable; successful vendor sample runs are not native adapter build tests.
