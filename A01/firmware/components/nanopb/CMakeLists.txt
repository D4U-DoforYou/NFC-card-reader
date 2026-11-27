if(COMMAND idf_component_register)
    idf_component_register(
        SRCS "pb_common.c" "pb_decode.c" "pb_encode.c"
        INCLUDE_DIRS ".")
else()
    add_library(nanopb_runtime pb_common.c pb_decode.c pb_encode.c)
    target_include_directories(nanopb_runtime PUBLIC .)
    target_compile_features(nanopb_runtime PUBLIC c_std_99)
endif()
