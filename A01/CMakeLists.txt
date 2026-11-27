cmake_minimum_required(VERSION 3.22)

set(EXTRA_COMPONENT_DIRS
	"${CMAKE_CURRENT_LIST_DIR}/firmware/main"
	"${CMAKE_CURRENT_LIST_DIR}/firmware/components")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(rf_device_platform VERSION 0.2.7)

add_custom_target(copy_firmware_to_output ALL
	COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_SOURCE_DIR}/output"
	COMMAND ${CMAKE_COMMAND} -E copy
		"${CMAKE_BINARY_DIR}/${CMAKE_PROJECT_NAME}.bin"
		"${CMAKE_SOURCE_DIR}/output/${CMAKE_PROJECT_NAME}-${PROJECT_VERSION}.bin"
	COMMAND ${CMAKE_COMMAND} -E copy
		"${CMAKE_BINARY_DIR}/merged-binary.bin"
		"${CMAKE_SOURCE_DIR}/output/${CMAKE_PROJECT_NAME}-${PROJECT_VERSION}-full.bin"
	COMMAND ${CMAKE_COMMAND} -E copy
		"${CMAKE_BINARY_DIR}/bootloader/bootloader.bin"
		"${CMAKE_SOURCE_DIR}/output/${CMAKE_PROJECT_NAME}-${PROJECT_VERSION}-bootloader.bin"
	COMMAND ${CMAKE_COMMAND} -E copy
		"${CMAKE_BINARY_DIR}/partition_table/partition-table.bin"
		"${CMAKE_SOURCE_DIR}/output/${CMAKE_PROJECT_NAME}-${PROJECT_VERSION}-partition-table.bin"
	COMMAND ${CMAKE_COMMAND} -E copy
		"${CMAKE_BINARY_DIR}/ota_data_initial.bin"
		"${CMAKE_SOURCE_DIR}/output/${CMAKE_PROJECT_NAME}-${PROJECT_VERSION}-ota-data.bin"
	DEPENDS app merge-bin
	COMMENT "Copying firmware images to output/"
)