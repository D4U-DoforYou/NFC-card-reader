if(DEFINED COMPONENT_DIR)
    get_filename_component(REPOSITORY_ROOT "${COMPONENT_DIR}/../../.." ABSOLUTE)
else()
    set(REPOSITORY_ROOT "${CMAKE_SOURCE_DIR}")
endif()

set(PROTOCOL_DIR "${REPOSITORY_ROOT}/protocol")
set(NANOPB_DIR "${REPOSITORY_ROOT}/firmware/components/nanopb")
set(PROTOCOL_GENERATED_DIR "${CMAKE_CURRENT_SOURCE_DIR}")

file(GLOB_RECURSE PROTOCOL_FILES CONFIGURE_DEPENDS "${PROTOCOL_DIR}/*.proto")
file(GLOB_RECURSE PROTOCOL_OPTIONS CONFIGURE_DEPENDS "${PROTOCOL_DIR}/*.options")
if(NOT PROTOCOL_FILES)
    message(FATAL_ERROR "No .proto files found under ${PROTOCOL_DIR}")
endif()

if(DEFINED ENV{RF_PROTOCOL_PYTHON} AND NOT "$ENV{RF_PROTOCOL_PYTHON}" STREQUAL "")
    set(PROTOCOL_PYTHON "$ENV{RF_PROTOCOL_PYTHON}")
else()
    find_package(Python3 COMPONENTS Interpreter REQUIRED)
    set(PROTOCOL_PYTHON "${Python3_EXECUTABLE}")
endif()

execute_process(
    COMMAND "${PROTOCOL_PYTHON}" -c
            "import grpc_tools.protoc; import nanopb.generator.nanopb_generator"
    RESULT_VARIABLE PROTOCOL_GENERATOR_CHECK
    OUTPUT_QUIET
    ERROR_QUIET
)
if(NOT PROTOCOL_GENERATOR_CHECK EQUAL 0)
    message(FATAL_ERROR
        "Protocol generation requires nanopb and grpcio-tools.\n"
        "Python: ${PROTOCOL_PYTHON}\n"
        "Fix: \"${PROTOCOL_PYTHON} -m pip install nanopb grpcio-tools\", or set RF_PROTOCOL_PYTHON to a Python environment containing both packages.")
endif()

set(PROTOCOL_GENERATED_SOURCES)
set(PROTOCOL_GENERATED_HEADERS)
foreach(PROTO_FILE IN LISTS PROTOCOL_FILES)
    file(RELATIVE_PATH PROTO_RELATIVE "${PROTOCOL_DIR}" "${PROTO_FILE}")
    string(REGEX REPLACE "\\.proto$" ".pb.c" GENERATED_C "${PROTO_RELATIVE}")
    string(REGEX REPLACE "\\.proto$" ".pb.h" GENERATED_H "${PROTO_RELATIVE}")
    list(APPEND PROTOCOL_GENERATED_SOURCES "${PROTOCOL_GENERATED_DIR}/${GENERATED_C}")
    list(APPEND PROTOCOL_GENERATED_HEADERS "${PROTOCOL_GENERATED_DIR}/${GENERATED_H}")
endforeach()

add_custom_command(
    OUTPUT ${PROTOCOL_GENERATED_SOURCES} ${PROTOCOL_GENERATED_HEADERS}
    COMMAND "${PROTOCOL_PYTHON}" -m nanopb.generator.nanopb_generator
            --no-timestamp
            "--proto-path=${PROTOCOL_DIR}"
            "--output-dir=${PROTOCOL_GENERATED_DIR}" ${PROTOCOL_FILES}
    DEPENDS ${PROTOCOL_FILES} ${PROTOCOL_OPTIONS}
    COMMENT "Generating nanopb protocol bindings"
    VERBATIM
)

add_library(rf_device_protocol_bindings STATIC ${PROTOCOL_GENERATED_SOURCES})
target_include_directories(rf_device_protocol_bindings PUBLIC
    "${PROTOCOL_GENERATED_DIR}"
    "${NANOPB_DIR}")
