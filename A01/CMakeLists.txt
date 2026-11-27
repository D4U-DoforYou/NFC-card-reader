cmake_minimum_required(VERSION 3.22)

set(EXTRA_COMPONENT_DIRS
	"${CMAKE_CURRENT_LIST_DIR}/firmware/main"
	"${CMAKE_CURRENT_LIST_DIR}/firmware/components")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(rf_device_platform VERSION 0.2.6)

add_custom_target(copy_firmware_to_output ALL
	COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_SOURCE_DIR}/output"
	COMMAND ${CMAKE_COMMAND} -E copy
		"${CMAKE_BINARY_DIR}/${CMAKE_PROJECT_NAME}.bin"
		"${CMAKE_SOURCE_DIR}/output/${CMAKE_PROJECT_NAME}-${PROJECT_VERSION}.bin"
	DEPENDS app
	COMMENT "Copying firmware image to output/"
)
