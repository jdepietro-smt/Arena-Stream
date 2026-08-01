cmake_minimum_required(VERSION 3.20)
project(sdi_stream C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ----------------------------------------------------------------------
# Platform defines — applied globally so SDK headers see the right macros.
# ----------------------------------------------------------------------
if(WIN32)
    add_compile_definitions(
        WIN32_LEAN_AND_MEAN   # exclude rarely-used Windows headers
        NOMINMAX              # prevent windows.h min/max macros
        _CRT_SECURE_NO_WARNINGS
        UNICODE _UNICODE
    )
endif()

# ----------------------------------------------------------------------
# Options: toggle card support at configure time. You need at least one.
# ----------------------------------------------------------------------
option(ENABLE_DECKLINK "Build DeckLink capture backend" ON)
option(ENABLE_AJA      "Build AJA NTV2 capture backend" ON)
option(ENABLE_NDI      "Build NDI capture/output backend" OFF)

if(NOT ENABLE_DECKLINK AND NOT ENABLE_AJA AND NOT ENABLE_NDI)
    message(WARNING "ENABLE_DECKLINK, ENABLE_AJA, and ENABLE_NDI are all OFF. "
        "sdi_stream will compile but cannot capture from any source at runtime.")
endif()

# ----------------------------------------------------------------------
# Vendor SDKs — set these paths or pass on the command line:
#   cmake -DDECKLINK_SDK_DIR=C:/SDKs/Blackmagic/include \
#         -DAJA_NTV2_DIR=C:/SDKs/libajantv2 \
#         -DNDI_SDK_DIR="C:/Program Files/NDI/NDI 6 SDK" ...
# ----------------------------------------------------------------------
set(DECKLINK_SDK_DIR "" CACHE PATH "Path to Blackmagic DeckLink SDK include directory")
set(AJA_NTV2_DIR     "" CACHE PATH "Path to AJA NTV2 SDK (top-level, contains ajantv2/ and ajabase/)")
set(NDI_SDK_DIR      "" CACHE PATH "Path to NDI SDK root (contains Include/ and Lib/x64/)")

find_package(Threads REQUIRED)

# ----------------------------------------------------------------------
# Dependency resolution — normalised into two INTERFACE targets:
#   sdi_srt_iface   — libsrt
#   sdi_ffmpeg_iface — libavcodec + libavformat + libavutil + swscale + swresample
#
# Windows: resolved via vcpkg (pass -DCMAKE_TOOLCHAIN_FILE=.../vcpkg.cmake).
#   vcpkg install srt ffmpeg[avcodec,avformat,avutil,swscale,swresample,nvcodec]
#
# Linux / macOS: resolved via pkg-config.
# ----------------------------------------------------------------------
add_library(sdi_srt_iface    INTERFACE)
add_library(sdi_ffmpeg_iface INTERFACE)

if(WIN32)
    # ---- SRT (vcpkg: install libsrt) ----
    # vcpkg's libsrt port does not install CMake config files — only srt.lib
    # and headers. Use find_library + find_path directly.
    find_library(SRT_LIB NAMES srt srt_static REQUIRED)
    find_path(SRT_INCLUDE NAMES srt/srt.h REQUIRED)
    target_link_libraries(sdi_srt_iface INTERFACE ${SRT_LIB})
    target_include_directories(sdi_srt_iface INTERFACE ${SRT_INCLUDE})
    message(STATUS "SRT: ${SRT_LIB}")

    # ---- FFmpeg (vcpkg: install ffmpeg[x264,opus,srt]) ----
    # vcpkg ships FindFFMPEG.cmake (a Find module, not a config file).
    # Do NOT use CONFIG keyword — use module mode so FindFFMPEG.cmake is found.
    find_package(FFMPEG REQUIRED)
    target_include_directories(sdi_ffmpeg_iface INTERFACE ${FFMPEG_INCLUDE_DIRS})
    target_link_libraries(sdi_ffmpeg_iface INTERFACE ${FFMPEG_LIBRARIES})
    message(STATUS "FFmpeg includes: ${FFMPEG_INCLUDE_DIRS}")
    message(STATUS "FFmpeg libs: ${FFMPEG_LIBRARIES}")

    # SRT on Windows needs Winsock.
    target_link_libraries(sdi_srt_iface INTERFACE ws2_32)
else()
    # ---- Linux / macOS: use pkg-config ----
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(SRT        REQUIRED IMPORTED_TARGET srt)
    pkg_check_modules(AVCODEC    REQUIRED IMPORTED_TARGET libavcodec)
    pkg_check_modules(AVFORMAT   REQUIRED IMPORTED_TARGET libavformat)
    pkg_check_modules(AVUTIL     REQUIRED IMPORTED_TARGET libavutil)
    pkg_check_modules(AVFILTER   REQUIRED IMPORTED_TARGET libavfilter)
    pkg_check_modules(SWSCALE    REQUIRED IMPORTED_TARGET libswscale)
    pkg_check_modules(SWRESAMPLE REQUIRED IMPORTED_TARGET libswresample)

    target_link_libraries(sdi_srt_iface INTERFACE PkgConfig::SRT)
    target_link_libraries(sdi_ffmpeg_iface INTERFACE
        PkgConfig::AVCODEC PkgConfig::AVFORMAT PkgConfig::AVUTIL PkgConfig::AVFILTER
        PkgConfig::SWSCALE PkgConfig::SWRESAMPLE)
endif()

# ----------------------------------------------------------------------
# Core library — device-agnostic pieces.
# ----------------------------------------------------------------------
add_library(sdi_core STATIC
    src/frame_queue.cpp
    src/capture_device.cpp
    src/playout_device.cpp
    src/encoder.cpp
    src/srt_output.cpp
    src/redundancy.cpp
    src/srt_input.cpp
    src/stats_server.cpp
)
target_include_directories(sdi_core PUBLIC include)
target_link_libraries(sdi_core PUBLIC
    Threads::Threads
    sdi_srt_iface
    sdi_ffmpeg_iface
)
# capture_device.cpp uses #ifdef SDI_WITH_AJA / SDI_WITH_DECKLINK / SDI_WITH_NDI to select
# which backends to instantiate.  Define them on sdi_core so the guards fire
# at compile time — they must be set here, not only on the backend targets.
if(ENABLE_AJA)
    target_compile_definitions(sdi_core PUBLIC SDI_WITH_AJA=1)
endif()
if(ENABLE_DECKLINK)
    target_compile_definitions(sdi_core PUBLIC SDI_WITH_DECKLINK=1)
endif()
if(ENABLE_NDI)
    target_compile_definitions(sdi_core PUBLIC SDI_WITH_NDI=1)
endif()

# ----------------------------------------------------------------------
# DeckLink backend
# ----------------------------------------------------------------------
if(ENABLE_DECKLINK)
    if(NOT DECKLINK_SDK_DIR)
        message(FATAL_ERROR "ENABLE_DECKLINK is ON but DECKLINK_SDK_DIR is unset.\n"
            "Download Desktop Video SDK from https://www.blackmagicdesign.com/support\n"
            "and pass -DDECKLINK_SDK_DIR=/path/to/include")
    endif()

    add_library(sdi_decklink STATIC src/decklink_device.cpp src/decklink_playout.cpp)
    target_include_directories(sdi_decklink PUBLIC ${DECKLINK_SDK_DIR})
    target_compile_definitions(sdi_decklink PUBLIC SDI_WITH_DECKLINK=1)

    if(WIN32)
        # Windows: DeckLink registers as a COM in-process server (BlackmagicDesktopVideoW64.dll).
        # No dispatch file — CoCreateInstance(CLSID_CDeckLinkIterator) does the lookup.
        # DeckLinkAPI_i.c (MIDL-generated) provides CLSID/IID constant definitions.
        # ole32 / oleaut32 are the COM runtime libs.
        target_sources(sdi_decklink PRIVATE ${DECKLINK_SDK_DIR}/DeckLinkAPI_i.c)
        target_link_libraries(sdi_decklink PUBLIC sdi_core ole32 oleaut32)
    elseif(APPLE)
        # macOS: same COM-style header; the SDK ships DeckLinkAPIDispatch.cpp for macOS too.
        target_sources(sdi_decklink PRIVATE ${DECKLINK_SDK_DIR}/DeckLinkAPIDispatch.cpp)
        target_link_libraries(sdi_decklink PUBLIC sdi_core)
    else()
        # Linux: compile the dispatch file that implements CreateDeckLinkIteratorInstance().
        target_sources(sdi_decklink PRIVATE ${DECKLINK_SDK_DIR}/DeckLinkAPIDispatch.cpp)
        target_link_libraries(sdi_decklink PUBLIC sdi_core dl)
    endif()
endif()

# ----------------------------------------------------------------------
# AJA backend
# ----------------------------------------------------------------------
if(ENABLE_AJA)
    if(NOT AJA_NTV2_DIR)
        message(FATAL_ERROR "ENABLE_AJA is ON but AJA_NTV2_DIR is unset.\n"
            "Download NTV2 SDK from https://github.com/aja-video/libajantv2\n"
            "and pass -DAJA_NTV2_DIR=/path/to/libajantv2")
    endif()

    add_library(sdi_aja STATIC src/aja_device.cpp src/aja_playout.cpp)
    target_include_directories(sdi_aja PUBLIC
        ${AJA_NTV2_DIR}/ajantv2/includes
        ${AJA_NTV2_DIR}           # ajabase headers are included as "ajabase/..."
    )
    # On Windows the AJA SDK needs the platform-specific driver interface header.
    if(WIN32)
        target_include_directories(sdi_aja PUBLIC ${AJA_NTV2_DIR}/ajantv2/src/win)
    endif()
    # Locate the pre-built ajantv2 static library produced by the NTV2 SDK build.
    find_library(AJANTV2_LIB
        NAMES ajantv2 ajantv2_vs143_MT ajantv2_vs143 libajantv2
        PATHS "${AJA_NTV2_DIR}/build/ajantv2/Release"
              "${AJA_NTV2_DIR}/build/ajantv2"
              "${AJA_NTV2_DIR}/build"
              "${AJA_NTV2_DIR}/lib"
        NO_DEFAULT_PATH
        REQUIRED
    )
    message(STATUS "AJA NTV2 lib: ${AJANTV2_LIB}")

    # mbedTLS is vendored inside the AJA SDK build tree.
    set(_AJA_MBEDTLS_DIR "${AJA_NTV2_DIR}/build/ajantv2/mbedtls-install/lib")
    find_library(MBEDTLS_LIB    mbedtls    PATHS "${_AJA_MBEDTLS_DIR}" NO_DEFAULT_PATH REQUIRED)
    find_library(MBEDX509_LIB   mbedx509   PATHS "${_AJA_MBEDTLS_DIR}" NO_DEFAULT_PATH REQUIRED)
    find_library(MBEDCRYPTO_LIB mbedcrypto PATHS "${_AJA_MBEDTLS_DIR}" NO_DEFAULT_PATH REQUIRED)
    find_library(EVEREST_LIB    everest    PATHS "${_AJA_MBEDTLS_DIR}" NO_DEFAULT_PATH REQUIRED)
    find_library(P256M_LIB      p256m      PATHS "${_AJA_MBEDTLS_DIR}" NO_DEFAULT_PATH REQUIRED)
    message(STATUS "mbedtls: ${MBEDTLS_LIB}")

    target_link_libraries(sdi_aja PUBLIC
        sdi_core
        "${AJANTV2_LIB}"
        "${MBEDTLS_LIB}" "${MBEDX509_LIB}" "${MBEDCRYPTO_LIB}" "${EVEREST_LIB}" "${P256M_LIB}"
        # Windows system libraries required by ajantv2 + mbedcrypto
        winmm setupapi cfgmgr32 netapi32 wbemuuid shlwapi bcrypt
    )
    target_compile_definitions(sdi_aja PUBLIC SDI_WITH_AJA=1)
    # AJA SDK requires a platform macro. On Windows it expects MSWindows.
    if(WIN32)
        target_compile_definitions(sdi_aja PUBLIC MSWindows=1)
    endif()
endif()

# ----------------------------------------------------------------------
# NDI backend
# ----------------------------------------------------------------------
if(ENABLE_NDI)
    if(NOT NDI_SDK_DIR)
        message(FATAL_ERROR "ENABLE_NDI is ON but NDI_SDK_DIR is unset.\n"
            "Download the free NDI SDK from https://ndi.video/for-developers\n"
            "and pass -DNDI_SDK_DIR=\"C:/Program Files/NDI/NDI 6 SDK\"")
    endif()

    add_library(sdi_ndi STATIC src/ndi_device.cpp)
    target_include_directories(sdi_ndi PUBLIC "${NDI_SDK_DIR}/Include")
    target_compile_definitions(sdi_ndi PUBLIC SDI_WITH_NDI=1)

    # Locate the NDI import library.
    if(WIN32)
        find_library(NDI_LIB
            NAMES "Processing.NDI.Lib.x64"
            PATHS "${NDI_SDK_DIR}/Lib/x64"
            NO_DEFAULT_PATH
            REQUIRED
        )
    elseif(APPLE)
        find_library(NDI_LIB
            NAMES ndi
            PATHS "${NDI_SDK_DIR}/lib/macOS"
            NO_DEFAULT_PATH
            REQUIRED
        )
    else()
        find_library(NDI_LIB
            NAMES ndi
            PATHS "${NDI_SDK_DIR}/lib/x86_64-linux-gnu"
            NO_DEFAULT_PATH
            REQUIRED
        )
    endif()
    message(STATUS "NDI lib: ${NDI_LIB}")
    target_link_libraries(sdi_ndi PUBLIC sdi_core "${NDI_LIB}")
    target_compile_definitions(sdi_ndi PUBLIC SDI_WITH_NDI=1)
endif()

# ----------------------------------------------------------------------
# Compiler warning flags — helper function so we apply consistently.
# ----------------------------------------------------------------------
function(sdi_target_warnings target)
    if(MSVC)
        target_compile_options(${target} PRIVATE
            /W4
            /wd4100   # unreferenced formal parameter
            /wd4201   # nonstandard extension: nameless struct/union (COM headers)
            /wd4996   # deprecated POSIX names
        )
    else()
        target_compile_options(${target} PRIVATE
            -Wall -Wextra -Wpedantic -Wno-unused-parameter)
    endif()
endfunction()

# ----------------------------------------------------------------------
# Main binary (sender) — Arena Stream
# ----------------------------------------------------------------------
add_executable(arena_stream src/main.cpp)
if(WIN32)
    target_sources(arena_stream PRIVATE ${CMAKE_SOURCE_DIR}/arena_stream.rc)
endif()
target_link_libraries(arena_stream PRIVATE sdi_core)
if(ENABLE_DECKLINK)
    target_link_libraries(arena_stream PRIVATE sdi_decklink)
endif()
if(ENABLE_AJA)
    target_link_libraries(arena_stream PRIVATE sdi_aja)
endif()
if(ENABLE_NDI)
    target_link_libraries(arena_stream PRIVATE sdi_ndi)
    target_include_directories(arena_stream PRIVATE "${NDI_SDK_DIR}/Include")
    if(WIN32)
        add_custom_command(TARGET arena_stream POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${NDI_SDK_DIR}/Bin/x64/Processing.NDI.Lib.x64.dll"
                "$<TARGET_FILE_DIR:arena_stream>/Processing.NDI.Lib.x64.dll"
            COMMENT "Copying NDI runtime DLL to output directory"
        )
    endif()
endif()
sdi_target_warnings(arena_stream)

# ----------------------------------------------------------------------
# Receiver binary — SMPTE 2022-7 protection-switch gateway.
# No vendor SDK dependency; just sdi_core (FFmpeg + SRT).
# ----------------------------------------------------------------------
add_executable(sdi_receive src/receive_main.cpp)
target_link_libraries(sdi_receive PRIVATE sdi_core)
sdi_target_warnings(sdi_receive)

# ----------------------------------------------------------------------
# sdi_player — SRT receiver with direct libsrt stats + SEI latency
# ----------------------------------------------------------------------
add_executable(sdi_player src/sdi_player.cpp)
target_link_libraries(sdi_player PRIVATE sdi_core)
if(WIN32)
    target_link_libraries(sdi_player PRIVATE ws2_32)
endif()
sdi_target_warnings(sdi_player)

# ----------------------------------------------------------------------
# sdi_decoder — receive-side decoder: SRT -> H.264/Opus decode -> SDI output.
# Runs at a remote facility to play the stream back out to physical SDI
# (monitor wall, switcher, etc.) via either vendor's output backend.
# ----------------------------------------------------------------------
add_executable(sdi_decoder src/decoder_main.cpp)
target_link_libraries(sdi_decoder PRIVATE sdi_core)
if(ENABLE_DECKLINK)
    target_link_libraries(sdi_decoder PRIVATE sdi_decklink)
endif()
if(ENABLE_AJA)
    target_link_libraries(sdi_decoder PRIVATE sdi_aja)
endif()
if(WIN32)
    target_link_libraries(sdi_decoder PRIVATE ws2_32)
endif()
sdi_target_warnings(sdi_decoder)

# ===========================================================================
# Install rules
# ===========================================================================
include(GNUInstallDirs)

install(TARGETS arena_stream sdi_receive sdi_decoder
    RUNTIME DESTINATION .
)

# Using x64-windows-static: all dependencies are statically linked.
# No runtime DLLs need to be bundled.

# Pipeline scripts (installed so the control plane can find them).
install(DIRECTORY "${CMAKE_SOURCE_DIR}/../pipelines/"
    DESTINATION pipelines
    FILES_MATCHING
        PATTERN "*.sh"
        PATTERN "*.env"
        PATTERN "_lib.sh"
)

# ===========================================================================
# CPack — produces a platform installer from the install tree.
#
# Windows (NSIS):
#   cmake --build build --config Release --target package
#   → build/SDI-Streaming-0.1.0-win64.exe
#
# Prerequisite: NSIS 3.x installed and on PATH.
#   winget install NSIS.NSIS
# ===========================================================================
set(CPACK_PACKAGE_NAME                "SMT-Arena")
set(CPACK_PACKAGE_VENDOR              "SMT")
set(CPACK_PACKAGE_VERSION             "0.1.0")
set(CPACK_PACKAGE_VERSION_MAJOR       "0")
set(CPACK_PACKAGE_VERSION_MINOR       "1")
set(CPACK_PACKAGE_VERSION_PATCH       "0")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "SMT Arena — SDI capture and SRT streaming")
set(CPACK_PACKAGE_DESCRIPTION
    "SMT Arena: professional SDI capture, encode, and SRT streaming suite.\n"
    "Includes Arena Stream (sender) and Arena DVR (web receiver).\n"
    "Supports Blackmagic DeckLink and AJA NTV2 cards."
)
set(CPACK_PACKAGE_INSTALL_DIRECTORY   "SMT Arena")
set(CPACK_PACKAGE_EXECUTABLES         "arena_stream;Arena Stream")

# Tell CPack to skip its own internal cmake --install and instead package
# directly from the pre-populated stage directory (which includes both the
# cmake-built C++ binaries AND the dotnet-published GUI).
set(CPACK_INSTALL_CMAKE_PROJECTS      "")
set(CPACK_INSTALLED_DIRECTORIES       "${CMAKE_INSTALL_PREFIX};.")

# On Windows, default to NSIS; on Linux default to DEB.
if(WIN32)
    set(CPACK_GENERATOR "NSIS")
else()
    set(CPACK_GENERATOR "DEB")
endif()

# ---------------------------------------------------------------------------
# NSIS (Windows) config
# ---------------------------------------------------------------------------
set(CPACK_NSIS_PACKAGE_NAME          "SMT Arena ${CPACK_PACKAGE_VERSION}")
set(CPACK_NSIS_DISPLAY_NAME          "SMT Arena")
set(CPACK_NSIS_INSTALL_ROOT          "$PROGRAMFILES64")
set(CPACK_NSIS_ENABLE_UNINSTALL_BEFORE_INSTALL ON)
set(CPACK_NSIS_MODIFY_PATH           ON)

set(CPACK_NSIS_EXECUTABLES_DIRECTORY ".")

set(CPACK_CREATE_DESKTOP_LINKS       "arena_stream")

set(CPACK_NSIS_CREATE_ICONS_EXTRA
    "CreateShortCut '$DESKTOP\\\\Arena Stream.lnk' '$INSTDIR\\\\arena_stream.exe'"
)

set(CPACK_NSIS_DELETE_ICONS_EXTRA
    "Delete '$DESKTOP\\\\Arena Stream.lnk'"
)

# ---------------------------------------------------------------------------
# DEB (Linux) config
# ---------------------------------------------------------------------------
set(CPACK_DEBIAN_PACKAGE_MAINTAINER    "SMT <engineering@smt.com>")
set(CPACK_DEBIAN_PACKAGE_SECTION       "video")
set(CPACK_DEBIAN_PACKAGE_DEPENDS
    "libsrt-openssl (>= 1.5), libavcodec60, libavformat60, libavutil58, libavfilter9, libswscale7, libswresample4"
)
set(CPACK_DEBIAN_PACKAGE_DESCRIPTION
    "SDI capture → encode → SRT streaming tools\n"
    " Supports Blackmagic DeckLink and AJA NTV2 cards.\n"
    " Includes sdi_stream, sdi_receive, and the web-based control plane."
)

include(CPack)
