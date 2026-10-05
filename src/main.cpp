#include "physics.hpp"
#include "xdg-shell-client-protocol.h"
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <wayland-client.h>
#include <wayland-egl.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <fstream>
#include <filesystem>
#include <iostream>
#include <memory>
#include <mutex>
#include <poll.h>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <vector>
#include <fcntl.h>
#include <unistd.h>
using json=nlohmann::json;
using Clock=std::chrono::steady_clock;
static double milliseconds(){return std::chrono::duration<double,std::milli>(Clock::now().time_since_epoch()).count();}
static volatile sig_atomic_t interrupted=0;
static void signalHandler(int){interrupted=1;}
static void require(bool ok,const std::string& message){if(!ok)throw std::runtime_error(message);}
static std::string readFile(const std::string& path){std::ifstream in(path);require(bool(in),"Cannot read "+path);std::ostringstream out;out<<in.rdbuf();return out.str();}
struct PaintingData{
 std::vector<float> homes,colors,sizes;std::vector<uint8_t> classes;double aspect;int rows;
 explicit PaintingData(const std::string& file){
  GError* error=nullptr;GdkPixbuf* original=gdk_pixbuf_new_from_file(file.c_str(),&error);
  if(!original){std::string why=error?error->message:"Image decode failed";g_clear_error(&error);throw std::runtime_error(why);}
  aspect=double(gdk_pixbuf_get_width(original))/gdk_pixbuf_get_height(original);
  int cols=int(std::sqrt(96000*aspect));rows=96000/cols;int count=cols*rows;
  GdkPixbuf* image=gdk_pixbuf_scale_simple(original,cols,rows,GDK_INTERP_BILINEAR);g_object_unref(original);
  require(image,"Image resampling failed");
  const uint8_t* rgba=gdk_pixbuf_read_pixels(image);int stride=gdk_pixbuf_get_rowstride(image),channels=gdk_pixbuf_get_n_channels(image);
  homes.resize(count*3);colors.resize(count*3);classes.resize(count);sizes.resize(count);
  constexpr double sizeTable[]={0.65,0.85,1,1.25,1.55};
  for(int y=0;y<rows;y++)for(int x=0;x<cols;x++){
   int i=y*cols+x;const auto* pixel=rgba+y*stride+x*channels;double alpha=channels==4?pixel[3]/255.0:1.0;
   double luminance=(pixel[0]*0.2126+pixel[1]*0.7152+pixel[2]*0.0722)/255*alpha;
   double hash=std::sin((i+1)*127.1)*43758.5453;
   classes[i]=uint8_t(std::clamp(int(std::floor(luminance*4.5+(hash-std::floor(hash))*1.6-0.35)),0,4));sizes[i]=sizeTable[classes[i]];
   homes[i*3]=((x+0.5+std::sin(i*13.37)*0.16)/cols-0.5)*2*aspect;
   homes[i*3+1]=(0.5-(y+0.5+std::sin(i*7.91)*0.16)/rows)*2;
   for(int c=0;c<3;c++)colors[i*3+c]=pixel[c]/255.0*alpha;
  }
  g_object_unref(image);
 }
};
struct Host;
struct Screen{
 Host* host;int index,x,y;std::atomic<int> width,height;
 wl_surface* surface=nullptr;xdg_surface* shellSurface=nullptr;xdg_toplevel* top=nullptr;wl_egl_window* window=nullptr;
 std::atomic<bool> configured{false},ready{true},running{true};wl_callback* callback=nullptr;
 std::thread worker;std::mutex mutex;std::condition_variable wake;
 struct Input{double x,y,time;bool active;};std::vector<Input> inputs;
 std::atomic<uint64_t> frames{0},samples{0};std::atomic<double> physicsMs{0};
 Screen(Host* h,const json& config):host(h),index(config.at("index")),x(config.at("x")),y(config.at("y")),width(config.at("width")),height(config.at("height")){}
 void render();void stop(){running=false;wake.notify_all();}
};
struct Host{
 wl_display* display=nullptr;wl_registry* registry=nullptr;wl_compositor* compositor=nullptr;xdg_wm_base* shell=nullptr;
 wl_seat* seat=nullptr;wl_pointer* pointer=nullptr;Screen* pointerScreen=nullptr;
 EGLDisplay egl=EGL_NO_DISPLAY;EGLConfig config{};std::vector<std::unique_ptr<Screen>> screens;
 PaintingData painting;std::atomic<bool> paused{false},failed{false};bool preview=false;
 double brightness=.75,spring=.5,damping=.2;std::string capture;
 Host(const std::string& root):painting(root+"/assets/starry-night.jpg"){
  auto preset=json::parse(readFile(root+"/preset.json"));brightness=preset.value("brightness",.75);spring=preset.value("spring",.5);damping=preset.value("damping",.2);
 }
 void input(const json& data){
  if(data.value("type","")=="pause"){
   paused=data.value("paused",false);
   for(auto& s:screens){std::lock_guard<std::mutex> lock(s->mutex);s->inputs.clear();s->inputs.push_back({0,0,milliseconds(),false});s->wake.notify_all();}
  }else if(data.value("type","")=="pointer"){
   double x=data.value("x",0.),y=data.value("y",0.);bool active=data.value("active",false)&&std::isfinite(x)&&std::isfinite(y)&&x>=0&&x<=1&&y>=0&&y<=1;
   for(auto& s:screens){std::lock_guard<std::mutex> lock(s->mutex);if(s->inputs.size()>=256)s->inputs.clear();s->inputs.push_back({x,y,milliseconds(),active&&s->index==data.value("monitor",-1)});}
  }
 }
};
static void ping(void*,xdg_wm_base* shell,uint32_t serial){xdg_wm_base_pong(shell,serial);}
static const xdg_wm_base_listener shellListener={ping};
static void pointerEnter(void* data,wl_pointer*,uint32_t,wl_surface* surface,wl_fixed_t x,wl_fixed_t y){auto& h=*static_cast<Host*>(data);h.pointerScreen=static_cast<Screen*>(wl_surface_get_user_data(surface));if(h.preview&&h.pointerScreen)h.input({{"type","pointer"},{"monitor",h.pointerScreen->index},{"x",wl_fixed_to_double(x)/h.pointerScreen->width},{"y",wl_fixed_to_double(y)/h.pointerScreen->height},{"active",true}});}
static void pointerLeave(void* data,wl_pointer*,uint32_t,wl_surface*){auto& h=*static_cast<Host*>(data);if(h.preview)h.input({{"type","pointer"},{"active",false}});h.pointerScreen=nullptr;}
static void pointerMotion(void* data,wl_pointer*,uint32_t,wl_fixed_t x,wl_fixed_t y){auto& h=*static_cast<Host*>(data);if(h.preview&&h.pointerScreen)h.input({{"type","pointer"},{"monitor",h.pointerScreen->index},{"x",wl_fixed_to_double(x)/h.pointerScreen->width},{"y",wl_fixed_to_double(y)/h.pointerScreen->height},{"active",true}});}
static void pointerButton(void*,wl_pointer*,uint32_t,uint32_t,uint32_t,uint32_t){}
static void pointerAxis(void*,wl_pointer*,uint32_t,uint32_t,wl_fixed_t){}
static void pointerFrame(void*,wl_pointer*){}
static void pointerAxisSource(void*,wl_pointer*,uint32_t){}
static void pointerAxisStop(void*,wl_pointer*,uint32_t,uint32_t){}
static void pointerAxisDiscrete(void*,wl_pointer*,uint32_t,int32_t){}
static const wl_pointer_listener pointerListener={pointerEnter,pointerLeave,pointerMotion,pointerButton,pointerAxis,pointerFrame,pointerAxisSource,pointerAxisStop,pointerAxisDiscrete,nullptr,nullptr};
static void seatCapabilities(void* data,wl_seat* seat,uint32_t caps){auto& h=*static_cast<Host*>(data);if((caps&WL_SEAT_CAPABILITY_POINTER)&&!h.pointer){h.pointer=wl_seat_get_pointer(seat);wl_pointer_add_listener(h.pointer,&pointerListener,&h);}else if(!(caps&WL_SEAT_CAPABILITY_POINTER)&&h.pointer){wl_pointer_release(h.pointer);h.pointer=nullptr;h.pointerScreen=nullptr;}}
static void seatName(void*,wl_seat*,const char*){}
static const wl_seat_listener seatListener={seatCapabilities,seatName};
static void registryAdd(void* data,wl_registry* registry,uint32_t name,const char* interface,uint32_t version){
 auto& h=*static_cast<Host*>(data);
 if(std::string(interface)=="wl_seat"){h.seat=static_cast<wl_seat*>(wl_registry_bind(registry,name,&wl_seat_interface,std::min(version,5u)));wl_seat_add_listener(h.seat,&seatListener,&h);}
 if(std::string(interface)=="wl_compositor")h.compositor=static_cast<wl_compositor*>(wl_registry_bind(registry,name,&wl_compositor_interface,std::min(version,4u)));
 if(std::string(interface)=="xdg_wm_base"){h.shell=static_cast<xdg_wm_base*>(wl_registry_bind(registry,name,&xdg_wm_base_interface,std::min(version,2u)));xdg_wm_base_add_listener(h.shell,&shellListener,nullptr);}
}
static void registryRemove(void*,wl_registry*,uint32_t){}
static const wl_registry_listener registryListener={registryAdd,registryRemove};
static void shellConfigure(void* data,xdg_surface* surface,uint32_t serial){auto& s=*static_cast<Screen*>(data);xdg_surface_ack_configure(surface,serial);s.configured=true;s.wake.notify_all();}
static const xdg_surface_listener surfaceListener={shellConfigure};
static void topConfigure(void* data,xdg_toplevel*,int32_t width,int32_t height,wl_array*){auto& s=*static_cast<Screen*>(data);if(width>0)s.width=width;if(height>0)s.height=height;}
static void topClose(void* data,xdg_toplevel*){static_cast<Screen*>(data)->host->failed=true;}
static const xdg_toplevel_listener topListener={topConfigure,topClose,nullptr,nullptr};
static void frameDone(void* data,wl_callback* callback,uint32_t){auto& s=*static_cast<Screen*>(data);wl_callback_destroy(callback);s.callback=nullptr;s.ready=true;s.wake.notify_all();}
static const wl_callback_listener frameListener={frameDone};
static GLuint program(){
 const auto directory=std::filesystem::read_symlink("/proc/self/exe").parent_path()/"shaders";
 const std::array<std::string,2> paths={(directory/"painting.vert").string(),(directory/"painting.frag").string()};
 GLuint result=glCreateProgram();
 for(int i=0;i<2;i++){
  GLuint shader=glCreateShader(i?GL_FRAGMENT_SHADER:GL_VERTEX_SHADER);auto source=readFile(paths[i]);const char* ptr=source.c_str();glShaderSource(shader,1,&ptr,nullptr);glCompileShader(shader);
  GLint ok;glGetShaderiv(shader,GL_COMPILE_STATUS,&ok);char log[4096];if(!ok){glGetShaderInfoLog(shader,sizeof(log),nullptr,log);throw std::runtime_error(log);}glAttachShader(result,shader);glDeleteShader(shader);
 }
 glLinkProgram(result);GLint ok;glGetProgramiv(result,GL_LINK_STATUS,&ok);require(ok,"Shader link failed");return result;
}
static void captureFrame(const std::string& filename,int width,int height){
 std::vector<uint8_t> pixels(width*height*3),flipped(pixels.size());glPixelStorei(GL_PACK_ALIGNMENT,1);glReadPixels(0,0,width,height,GL_RGB,GL_UNSIGNED_BYTE,pixels.data());
 for(int y=0;y<height;y++)std::copy_n(pixels.data()+y*width*3,width*3,flipped.data()+(height-1-y)*width*3);
 GdkPixbuf* image=gdk_pixbuf_new_from_data(flipped.data(),GDK_COLORSPACE_RGB,false,8,width,height,width*3,nullptr,nullptr);GError* error=nullptr;
 if(!gdk_pixbuf_save(image,filename.c_str(),"png",&error,nullptr)){std::cerr<<"Capture: "<<error->message<<'\n';g_clear_error(&error);}g_object_unref(image);
}
void Screen::render(){
 EGLContext context=EGL_NO_CONTEXT;EGLSurface target=EGL_NO_SURFACE;
 try{
  {std::unique_lock<std::mutex> lock(mutex);wake.wait(lock,[&]{return configured||!running;});}if(!running)return;
  int w=width,h=height;window=wl_egl_window_create(surface,w,h);require(window,"wl_egl_window_create failed");
  eglBindAPI(EGL_OPENGL_ES_API);EGLint attrs[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};context=eglCreateContext(host->egl,host->config,EGL_NO_CONTEXT,attrs);require(context!=EGL_NO_CONTEXT,"EGL context failed");
  target=eglCreateWindowSurface(host->egl,host->config,reinterpret_cast<EGLNativeWindowType>(window),nullptr);require(target!=EGL_NO_SURFACE,"EGL surface failed");
  require(eglMakeCurrent(host->egl,target,target,context),"eglMakeCurrent failed");eglSwapInterval(host->egl,0);
  GLuint shader=program();glUseProgram(shader);GLuint vao;glGenVertexArrays(1,&vao);glBindVertexArray(vao);
  painting::Physics physics(host->painting.homes,host->painting.classes);physics.setDynamics(host->spring,host->damping);painting::Sampler sampler(240);
  GLuint buffers[5];glGenBuffers(5,buffers);
  const char* names[]={"position","aVelocity","aHome","aColor","aSize"};
  const std::vector<float>* values[]={&physics.positions,&physics.velocities,&host->painting.homes,&host->painting.colors,&host->painting.sizes};
  for(int i=0;i<5;i++){glBindBuffer(GL_ARRAY_BUFFER,buffers[i]);glBufferData(GL_ARRAY_BUFFER,values[i]->size()*sizeof(float),values[i]->data(),i<2?GL_DYNAMIC_DRAW:GL_STATIC_DRAW);GLint loc=glGetAttribLocation(shader,names[i]);require(loc>=0,"Missing shader attribute");glVertexAttribPointer(loc,i==4?1:3,GL_FLOAT,GL_FALSE,0,nullptr);glEnableVertexAttribArray(loc);}
  const GLint projection=glGetUniformLocation(shader,"projectionMatrix"),model=glGetUniformLocation(shader,"modelViewMatrix"),size=glGetUniformLocation(shader,"uSize"),time=glGetUniformLocation(shader,"uWaterTime");
  glUniform1f(glGetUniformLocation(shader,"uHaloScale"),2.2);glUniform1f(glGetUniformLocation(shader,"uBrightness"),host->brightness);
  float mv[]={1,0,0,0,0,1,0,0,0,0,1,0,0,0,-3,1};glUniformMatrix4fv(model,1,GL_FALSE,mv);
  glEnable(GL_BLEND);glBlendFunc(GL_ONE,GL_ONE_MINUS_SRC_ALPHA);glDisable(GL_DEPTH_TEST);glClearColor(7.f/255,10.f/255,17.f/255,1);
  double previous=0,accumulator=0,water=0;bool captured=false;std::vector<Input> batch;batch.reserve(256);
  while(running){
   {std::unique_lock<std::mutex> lock(mutex);wake.wait_for(lock,std::chrono::milliseconds(50),[&]{return !running||(ready&&!host->paused);});}
   if(!running)break;
   if(host->paused){previous=0;accumulator=0;sampler.reset();continue;}
   if(!ready.exchange(false))continue;
   int nextW=width,nextH=height;if(w!=nextW||h!=nextH){w=nextW;h=nextH;wl_egl_window_resize(window,w,h,0,0);sampler.reset();previous=0;}
   double now=milliseconds(),dt=previous?std::clamp((now-previous)/1000.,0.,1./15):0;previous=now;water+=dt;
   double displayHeight=std::min(double(h),w/host->painting.aspect),ppu=displayHeight/2;
   {std::lock_guard<std::mutex> lock(mutex);batch.swap(inputs);}for(auto p:batch){if(p.active)sampler.push((p.x*w-w/2.)/ppu,(h/2.-p.y*h)/ppu,p.time);else sampler.reset();}batch.clear();
   double started=milliseconds();sampler.drain(now,[&](const painting::Stroke& raw){auto stroke=raw;stroke.radius=std::clamp(65/ppu,.12,.34);stroke.strength=1;physics.disturb(stroke);samples++;},32);
   accumulator=std::min(accumulator+dt,8./120);int steps=0;while(accumulator>=1./120&&steps<8){physics.step(1./120);accumulator-=1./120;steps++;}physicsMs=milliseconds()-started;
   for(int i=0;i<2;i++){glBindBuffer(GL_ARRAY_BUFFER,buffers[i]);glBufferSubData(GL_ARRAY_BUFFER,0,values[i]->size()*sizeof(float),values[i]->data());}
   float pm[]={float(2*ppu/w),0,0,0,0,float(2*ppu/h),0,0,0,0,float(-2/9.9),0,0,0,float(-10.1/9.9),1};
   glUniformMatrix4fv(projection,1,GL_FALSE,pm);glUniform1f(size,std::max(1.,displayHeight/host->painting.rows*1.25));glUniform1f(time,water);
   glViewport(0,0,w,h);glClear(GL_COLOR_BUFFER_BIT);glDrawArrays(GL_POINTS,0,physics.positions.size()/3);
   if(!captured&&index==0&&!host->capture.empty()&&frames>=120){captureFrame(host->capture,w,h);captured=true;}
   // Callback is dispatched on the control thread; each screen is independently paced.
   callback=wl_surface_frame(surface);wl_callback_add_listener(callback,&frameListener,this);
   require(eglSwapBuffers(host->egl,target),"eglSwapBuffers failed");wl_display_flush(host->display);frames++;
  }
  glDeleteBuffers(5,buffers);glDeleteVertexArrays(1,&vao);glDeleteProgram(shader);
 }catch(const std::exception& e){std::cerr<<"Screen "<<index<<": "<<e.what()<<'\n';host->failed=true;}
 if(context!=EGL_NO_CONTEXT){eglMakeCurrent(host->egl,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);if(target!=EGL_NO_SURFACE)eglDestroySurface(host->egl,target);eglDestroyContext(host->egl,context);}if(window){wl_egl_window_destroy(window);window=nullptr;}eglReleaseThread();
}
int main(int argc,char** argv){
 try{
  require(argc>=3,"Usage: particle-wallpaper WALLPAPER_DIRECTORY MONITORS_JSON [--preview] [--duration=SECONDS] [--capture=PATH]");
  Host host(argv[1]);auto monitors=json::parse(argv[2]);double duration=0;
  for(int i=3;i<argc;i++){std::string arg=argv[i];if(arg=="--preview")host.preview=true;else if(arg.rfind("--duration=",0)==0)duration=std::stod(arg.substr(11));else if(arg.rfind("--capture=",0)==0)host.capture=arg.substr(10);}
  signal(SIGTERM,signalHandler);signal(SIGINT,signalHandler);signal(SIGPIPE,SIG_IGN);
  host.display=wl_display_connect(nullptr);require(host.display,"Wayland connection failed");host.registry=wl_display_get_registry(host.display);wl_registry_add_listener(host.registry,&registryListener,&host);wl_display_roundtrip(host.display);require(host.compositor&&host.shell,"Missing compositor/xdg-shell");
  host.egl=eglGetPlatformDisplay(EGL_PLATFORM_WAYLAND_KHR,host.display,nullptr);EGLint major,minor;require(eglInitialize(host.egl,&major,&minor),"EGL initialize failed");eglBindAPI(EGL_OPENGL_ES_API);
  EGLint attrs[]={EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_SURFACE_TYPE,EGL_WINDOW_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_NONE};EGLint count;require(eglChooseConfig(host.egl,attrs,&host.config,1,&count)&&count,"EGL config failed");
  for(auto& m:monitors){
   auto screen=std::make_unique<Screen>(&host,m);auto& s=*screen;s.surface=wl_compositor_create_surface(host.compositor);wl_surface_set_user_data(s.surface,&s);s.shellSurface=xdg_wm_base_get_xdg_surface(host.shell,s.surface);xdg_surface_add_listener(s.shellSurface,&surfaceListener,&s);s.top=xdg_surface_get_toplevel(s.shellSurface);xdg_toplevel_add_listener(s.top,&topListener,&s);
   json state={{"position",{s.x,s.y}},{"keepAtBottom",true},{"keepMinimized",true},{"keepPosition",true}};
   std::string title=host.preview?"Native Particle Preview":"@io.github.jeffshee.HanabiRenderer!"+state.dump()+"|"+std::to_string(s.index);
   xdg_toplevel_set_title(s.top,title.c_str());xdg_toplevel_set_app_id(s.top,"io.github.jeffshee.HanabiRenderer");
   if(!host.preview){xdg_toplevel_set_min_size(s.top,s.width,s.height);xdg_toplevel_set_max_size(s.top,s.width,s.height);}
   wl_surface_commit(s.surface);host.screens.push_back(std::move(screen));
  }
  wl_display_flush(host.display);for(auto& s:host.screens)s->worker=std::thread(&Screen::render,s.get());
  fcntl(STDIN_FILENO,F_SETFL,fcntl(STDIN_FILENO,F_GETFL)|O_NONBLOCK);std::string input;bool stdinOpen=true;
  double started=milliseconds(),metricsAt=started;std::vector<uint64_t> previousFrames(host.screens.size());
  std::string metricsFile=std::string(g_get_user_runtime_dir())+(host.preview?"/hanabi-native-preview.json":"/hanabi-native-metrics.json");
  while(!interrupted&&!host.failed&&(!duration||milliseconds()-started<duration*1000)){
   while(wl_display_prepare_read(host.display)!=0)if(wl_display_dispatch_pending(host.display)<0){host.failed=true;break;}
   if(host.failed)break;
   wl_display_flush(host.display);
   pollfd fds[]={{wl_display_get_fd(host.display),POLLIN,0},{stdinOpen?STDIN_FILENO:-1,POLLIN,0}};int result=poll(fds,2,10);
   if(result>=0&&(fds[0].revents&POLLIN)){if(wl_display_read_events(host.display)<0)host.failed=true;}else wl_display_cancel_read(host.display);
   if(fds[0].revents&(POLLERR|POLLHUP))host.failed=true;
   wl_display_dispatch_pending(host.display);
   if(fds[1].revents&(POLLIN|POLLHUP)){char buffer[8192];ssize_t n=read(STDIN_FILENO,buffer,sizeof(buffer));if(n>0){input.append(buffer,n);size_t pos;while((pos=input.find('\n'))!=std::string::npos){auto line=input.substr(0,pos);input.erase(0,pos+1);try{host.input(json::parse(line));}catch(const std::exception&){}}if(input.size()>65536)input.clear();}else if(n==0){stdinOpen=false;if(!host.preview)break;}}
   double now=milliseconds();if(now-metricsAt>=2000){json report=json::object();for(size_t i=0;i<host.screens.size();i++){auto& s=*host.screens[i];uint64_t frames=s.frames.load();report[std::to_string(s.index)]={{"fps",(frames-previousFrames[i])*1000/(now-metricsAt)},{"framesRendered",frames},{"count",host.painting.sizes.size()},{"width",s.width.load()},{"height",s.height.load()},{"paused",host.paused.load()},{"physicsMs",s.physicsMs.load()},{"interactionSamples",s.samples.load()},{"receivedAt",g_get_real_time()/1000}};previousFrames[i]=frames;}
    auto text=report.dump(2);g_file_set_contents(metricsFile.c_str(),text.c_str(),text.size(),nullptr);metricsAt=now;}
  }
  for(auto& s:host.screens)s->stop();
  for(auto& s:host.screens)if(s->worker.joinable())s->worker.join();
  for(auto& s:host.screens){if(s->callback)wl_callback_destroy(s->callback);xdg_toplevel_destroy(s->top);xdg_surface_destroy(s->shellSurface);wl_surface_destroy(s->surface);}
  eglTerminate(host.egl);if(host.pointer)wl_pointer_release(host.pointer);if(host.seat)wl_seat_release(host.seat);xdg_wm_base_destroy(host.shell);wl_compositor_destroy(host.compositor);wl_registry_destroy(host.registry);wl_display_disconnect(host.display);return host.failed?1:0;
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
