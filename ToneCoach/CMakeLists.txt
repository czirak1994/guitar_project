cmake_minimum_required(VERSION 3.22)
project(ToneCoach VERSION 1.0.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ------------------------------------------------------------------
# Point this to your JUCE checkout.
# Override from command line: cmake -DJUCE_DIR=/path/to/JUCE ..
# ------------------------------------------------------------------
if(NOT DEFINED JUCE_DIR)
    set(JUCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../JUCE"
        CACHE PATH "Path to JUCE root directory")
endif()

add_subdirectory(${JUCE_DIR} JUCE EXCLUDE_FROM_ALL)

juce_add_gui_app(ToneCoach
    VERSION                 1.0.0
    PRODUCT_NAME            "ToneCoach"
    BUNDLE_ID               "com.tonecoach.app"
    COMPANY_NAME            "ToneCoach"
    NEEDS_CURL              FALSE
    NEEDS_WEB_BROWSER       FALSE
)

target_sources(ToneCoach
    PRIVATE
        Source/Main.cpp
        Source/MainComponent.cpp
        Source/MainComponent.h
)

target_compile_definitions(ToneCoach
    PRIVATE
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:ToneCoach,JUCE_PRODUCT_NAME>"
        JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:ToneCoach,JUCE_VERSION>"
)

target_link_libraries(ToneCoach
    PRIVATE
        juce::juce_audio_basics
        juce::juce_audio_devices
        juce::juce_audio_formats
        juce::juce_audio_utils
        juce::juce_core
        juce::juce_data_structures
        juce::juce_events
        juce::juce_graphics
        juce::juce_gui_basics
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags
)
