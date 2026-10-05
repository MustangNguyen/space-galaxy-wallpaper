cmake_minimum_required(VERSION 3.18)
project(native_particle_wallpaper LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(PkgConfig REQUIRED)
pkg_check_modules(NATIVE REQUIRED IMPORTED_TARGET egl glesv2 wayland-client wayland-egl gdk-pixbuf-2.0)
find_package(Threads REQUIRED)
find_program(WAYLAND_SCANNER wayland-scanner REQUIRED)
add_custom_command(OUTPUT ${CMAKE_CURRENT_BINARY_DIR}/xdg-shell-client-protocol.h ${CMAKE_CURRENT_BINARY_DIR}/xdg-shell-protocol.c
 COMMAND ${WAYLAND_SCANNER} client-header ${CMAKE_CURRENT_SOURCE_DIR}/protocol/xdg-shell.xml ${CMAKE_CURRENT_BINARY_DIR}/xdg-shell-client-protocol.h
 COMMAND ${WAYLAND_SCANNER} private-code ${CMAKE_CURRENT_SOURCE_DIR}/protocol/xdg-shell.xml ${CMAKE_CURRENT_BINARY_DIR}/xdg-shell-protocol.c
 DEPENDS protocol/xdg-shell.xml)
add_executable(particle-wallpaper src/main.cpp src/physics.cpp ${CMAKE_CURRENT_BINARY_DIR}/xdg-shell-protocol.c)
find_path(NLOHMANN_JSON_INCLUDE_DIR nlohmann/json.hpp
 HINTS ${CMAKE_CURRENT_SOURCE_DIR}/../linux-wallpaperengine/src/External/json/include REQUIRED)
target_include_directories(particle-wallpaper PRIVATE src ${CMAKE_CURRENT_BINARY_DIR} ${NLOHMANN_JSON_INCLUDE_DIR})
target_compile_options(particle-wallpaper PRIVATE -Wall -Wextra -Wpedantic)
target_link_libraries(particle-wallpaper PRIVATE PkgConfig::NATIVE Threads::Threads)

add_custom_command(TARGET particle-wallpaper POST_BUILD COMMAND ${CMAKE_COMMAND} -E copy_directory ${CMAKE_CURRENT_SOURCE_DIR}/shaders $<TARGET_FILE_DIR:particle-wallpaper>/shaders)

include(CTest)
if(BUILD_TESTING)
 add_executable(physics-test tests/physics_test.cpp src/physics.cpp)
 target_include_directories(physics-test PRIVATE src)
 target_compile_options(physics-test PRIVATE -Wall -Wextra -Wpedantic -UNDEBUG)
 add_test(NAME physics-and-sampler COMMAND physics-test)
endif()
