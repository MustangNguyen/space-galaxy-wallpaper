#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <wayland-client.h>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
static void require(bool ok, const char* step) {
    if (!ok) { std::fprintf(stderr, "%s failed (EGL 0x%x)\n", step, eglGetError()); std::exit(1); }
}
int main(int argc, char** argv) {
    wl_display* wl = wl_display_connect(nullptr);
    require(wl != nullptr, "Wayland connection");
    EGLDisplay display = eglGetPlatformDisplay(EGL_PLATFORM_WAYLAND_KHR, wl, nullptr);
    EGLint major, minor;
    require(eglInitialize(display, &major, &minor), "eglInitialize");
    require(eglBindAPI(EGL_OPENGL_ES_API), "eglBindAPI");
    const EGLint attrs[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE};
    EGLConfig config; EGLint count;
    require(eglChooseConfig(display, attrs, &config, 1, &count) && count, "eglChooseConfig");
    const EGLint contextAttrs[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, contextAttrs);
    require(context != EGL_NO_CONTEXT, "eglCreateContext");
    require(eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, context), "surfaceless context");
    GLfloat range[2]; glGetFloatv(GL_ALIASED_POINT_SIZE_RANGE, range);
    std::printf("EGL %d.%d\nVendor: %s\nRenderer: %s\nGL: %s\nPoint sizes: %.0f..%.0f\n", major, minor,
        glGetString(GL_VENDOR), glGetString(GL_RENDERER), glGetString(GL_VERSION), range[0], range[1]);
    require(argc == 3, "vertex/fragment shader arguments");
    auto read = [](const char* file) { std::ifstream stream(file);std::ostringstream text;text<<stream.rdbuf();return text.str(); };
    std::string vertexText=read(argv[1]), fragmentText=read(argv[2]);
    const char* vertex=vertexText.c_str();const char* fragment=fragmentText.c_str();
    GLuint shaders[2] = {glCreateShader(GL_VERTEX_SHADER), glCreateShader(GL_FRAGMENT_SHADER)};
    const char* sources[2] = {vertex, fragment};
    for (int i=0;i<2;i++) {
        glShaderSource(shaders[i], 1, &sources[i], nullptr); glCompileShader(shaders[i]);
        GLint compiled; glGetShaderiv(shaders[i], GL_COMPILE_STATUS, &compiled);
        if(!compiled){char log[4096];glGetShaderInfoLog(shaders[i],sizeof(log),nullptr,log);std::fprintf(stderr,"%s\n",log);}
        require(compiled, "shader compile");
    }
    GLuint program=glCreateProgram();for(auto shader:shaders)glAttachShader(program,shader);glLinkProgram(program);
    GLint linked;glGetProgramiv(program,GL_LINK_STATUS,&linked);require(linked,"shader link");
    std::puts("Existing painting shaders: compiled and linked. No visible window created; FPS not tested.");
    glDeleteProgram(program);for(auto shader:shaders)glDeleteShader(shader);
    eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);
    eglDestroyContext(display,context);eglTerminate(display);wl_display_disconnect(wl);
}
