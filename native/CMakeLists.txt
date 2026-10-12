cmake_minimum_required(VERSION 3.20)
project(orbit360_stitch LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "The supplied Insta360 MediaSDK requires Windows x64 and the MSVC ABI.")
endif()

set(INSTA360_MEDIA_SDK "$ENV{INSTA360_MEDIA_SDK}" CACHE PATH "Private MediaSDK directory containing include, lib and bin")
if(NOT EXISTS "${INSTA360_MEDIA_SDK}/include/stitcher/ins_stitcher.h" OR
   NOT EXISTS "${INSTA360_MEDIA_SDK}/lib/MediaSDK.lib")
  message(FATAL_ERROR "Set -DINSTA360_MEDIA_SDK to your private, separately obtained MediaSDK directory.")
endif()

add_executable(orbit360-stitch main.cpp)
target_compile_features(orbit360-stitch PRIVATE cxx_std_17)
target_compile_definitions(orbit360-stitch PRIVATE WIN32 NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00)
target_include_directories(orbit360-stitch PRIVATE "${INSTA360_MEDIA_SDK}/include/stitcher")
target_compile_options(orbit360-stitch PRIVATE /W4 /utf-8 /EHsc)
target_link_libraries(orbit360-stitch PRIVATE "${INSTA360_MEDIA_SDK}/lib/MediaSDK.lib" delayimp)
target_link_options(orbit360-stitch PRIVATE /DELAYLOAD:MediaSDK.dll)
# SDK files remain in the user's private directory. No DLLs, models or headers are copied.
install(TARGETS orbit360-stitch RUNTIME DESTINATION bin)
