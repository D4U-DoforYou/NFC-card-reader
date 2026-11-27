cmake_minimum_required(VERSION 3.16)

if(COMMAND idf_component_register)
    idf_component_register(
        SRCS "src/capability_registry.cpp" "src/job.cpp"
             "src/job_scheduler.cpp" "src/job_router.cpp"
             "src/protocol_codec.cpp" "src/protocol_endpoint.cpp"
             "src/cobs_frame_codec.cpp"
        INCLUDE_DIRS "include"
        REQUIRES nanopb log)

    add_subdirectory(generated)
    target_link_libraries(${COMPONENT_LIB} PUBLIC rf_device_protocol_bindings)
    target_include_directories(${COMPONENT_LIB} PUBLIC "${CMAKE_CURRENT_LIST_DIR}/generated")
else()
    project(platform_core LANGUAGES C CXX)
    enable_testing()
    add_subdirectory(../nanopb ${CMAKE_CURRENT_BINARY_DIR}/nanopb)
    add_subdirectory(generated)

    add_library(platform_core src/capability_registry.cpp src/job.cpp
        src/job_scheduler.cpp src/job_router.cpp src/protocol_codec.cpp
        src/protocol_endpoint.cpp src/cobs_frame_codec.cpp)
    target_include_directories(platform_core PUBLIC include)
    target_compile_features(platform_core PUBLIC cxx_std_17)
    target_link_libraries(platform_core PUBLIC nanopb_runtime rf_device_protocol_bindings)

    add_executable(test_platform_core test/test_platform_core.cpp)
    target_link_libraries(test_platform_core PRIVATE platform_core)
    add_test(NAME platform_core COMMAND test_platform_core)
    add_executable(test_protocol_endpoint test/test_protocol_endpoint.cpp)
    target_link_libraries(test_protocol_endpoint PRIVATE platform_core)
    target_compile_definitions(test_protocol_endpoint PRIVATE
        RF_HELLO_VECTOR_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../../../protocol/test_vectors/hello_request.hex")
    add_test(NAME protocol_endpoint COMMAND test_protocol_endpoint)
    add_executable(test_framing test/test_framing.cpp)
    target_link_libraries(test_framing PRIVATE platform_core)
    target_compile_definitions(test_framing PRIVATE
        RF_HELLO_VECTOR_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../../../protocol/test_vectors/hello_request.hex"
        RF_USB_VECTOR_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../../../protocol/test_vectors/usb_hello.hex")
    add_test(NAME framing COMMAND test_framing)
endif()
