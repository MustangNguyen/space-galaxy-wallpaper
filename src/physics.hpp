#pragma once

#include <cstdint>
#include <functional>
#include <vector>

namespace painting {

struct Stroke {
    double fromX = 0.0;
    double fromY = 0.0;
    double toX = 0.0;
    double toY = 0.0;
    double vx = 0.0;
    double vy = 0.0;
    double radius = 0.0;
    double strength = 0.0;
};

class Physics {
public:
    std::vector<float> homes;
    std::vector<float> positions;
    std::vector<float> velocities;
    std::vector<float> sizes;
    std::vector<float> masses;
    std::vector<std::uint8_t> sizeClasses;

    Physics(std::vector<float> homes, std::vector<std::uint8_t> classes = {});
    void setDynamics(double spring, double damping);
    void disturb(const Stroke& stroke);
    void step(double dt);
    void reset();

private:
    double spring_ = 14.0;
    double damping_ = 2.3;
    std::vector<float> bounds_;
    std::vector<float> flow_;
    bool boundsDirty_ = true;
};

class Sampler {
public:
    explicit Sampler(int hz = 240);
    void push(double x, double y, double timeMs);
    void reset();
    void drain(double nowMs, const std::function<void(const Stroke&)>& callback, int limit = 32);

private:
    static constexpr int RawCapacity = 256;

    int hz_;
    double intervalMs_;
    std::vector<double> rawX_;
    std::vector<double> rawY_;
    std::vector<double> rawTime_;
    int rawStart_ = 0;
    int rawCount_ = 0;
    bool initialized_ = false;
    double sampleX_ = 0.0;
    double sampleY_ = 0.0;
    double sampleTime_ = 0.0;
    double nextTime_ = 0.0;
    double lastRawTime_ = 0.0;
    double observedRawGapMs_ = 0.0;
    bool hasRawSegment_ = false;
    Stroke sample_;

    void appendRaw(double x, double y, double timeMs);
    void discardBefore(double targetTime);
};

} // namespace painting
