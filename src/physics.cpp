#include "physics.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace painting {
namespace {

constexpr double MaxDt = 1.0 / 30.0;
constexpr double MaxSpeed = 2.6;
constexpr double MaxDisplacement = 1.25;
constexpr double MaxCursorSpeed = 5.0;
constexpr double FlowImpulsePerUnit = 4.2;
constexpr int BlockSize = 128;
constexpr std::array<double, 5> ParticleSizes{0.65, 0.85, 1.0, 1.25, 1.55};

constexpr double StaleMs = 200.0;
constexpr double SamplerMaxSpeed = 12.0;
constexpr double MaxEndpointWaitMs = 80.0;
constexpr double PositionEpsilonSq = 1e-16;
constexpr double TimeEpsilonMs = 1e-7;

double finiteOr(double value, double fallback) {
    return std::isfinite(value) ? value : fallback;
}

double clamp(double value, double minimum, double maximum) {
    return value < minimum ? minimum : value > maximum ? maximum : value;
}

bool supportedRate(int hz) {
    return hz == 30 || hz == 60 || hz == 120 || hz == 240;
}

} // namespace

Physics::Physics(std::vector<float> sourceHomes, std::vector<std::uint8_t> classes)
    : homes(std::move(sourceHomes)), positions(homes), velocities(homes.size(), 0.0f) {
    if (homes.size() % 3 != 0) {
        throw std::invalid_argument("homes must contain xyz triplets");
    }
    for (float value : homes) {
        if (!std::isfinite(value)) {
            throw std::invalid_argument("homes must contain only finite values");
        }
    }

    const std::size_t count = homes.size() / 3;
    if (classes.empty()) {
        sizeClasses.assign(count, 2);
    } else {
        if (classes.size() != count) {
            throw std::invalid_argument("sizeClasses must contain one class per particle");
        }
        sizeClasses = std::move(classes);
    }

    sizes.resize(count);
    masses.resize(count);
    for (std::size_t i = 0; i < count; ++i) {
        if (sizeClasses[i] >= ParticleSizes.size()) {
            throw std::invalid_argument("size class is out of range");
        }
        const float size = static_cast<float>(ParticleSizes[sizeClasses[i]]);
        sizes[i] = size;
        masses[i] = size * size;
    }

    bounds_.resize(((count + BlockSize - 1) / BlockSize) * 4);
    flow_.resize(count * 3);
    for (std::size_t i = 0; i < count; ++i) {
        const double x = homes[i * 3];
        const double y = homes[i * 3 + 1];
        flow_[i * 3] = static_cast<float>(std::sin(x * 11.0 + y * 7.0) * std::cos(y * 9.0 - x * 5.0));
        flow_[i * 3 + 1] = static_cast<float>(0.85 + 0.15 * std::sin(x * 19.0 + y * 13.0));
        flow_[i * 3 + 2] = static_cast<float>(0.28 * std::sin(x * 12.0 - y * 8.0));
    }
}

void Physics::setDynamics(double spring, double damping) {
    spring_ = clamp(finiteOr(spring, spring_), 0.5, 20.0);
    damping_ = clamp(finiteOr(damping, damping_), 0.2, 6.0);
}

void Physics::disturb(const Stroke& stroke) {
    const std::size_t count = homes.size() / 3;
    if (count == 0) return;

    const double fromX = finiteOr(stroke.fromX, 0.0);
    const double fromY = finiteOr(stroke.fromY, 0.0);
    const double toX = finiteOr(stroke.toX, fromX);
    const double toY = finiteOr(stroke.toY, fromY);
    const double segmentX = toX - fromX;
    const double segmentY = toY - fromY;
    const double segmentLengthSq = segmentX * segmentX + segmentY * segmentY;
    const double radius = clamp(finiteOr(stroke.radius, 0.0), 0.0, 1.0);
    const double strength = clamp(finiteOr(stroke.strength, 0.0), 0.0, 2.0);
    if (radius <= 0.0 || strength <= 0.0 || !(segmentLengthSq > 1e-12)) return;

    const double travel = std::sqrt(segmentLengthSq);
    const double cursorVX = finiteOr(stroke.vx, 0.0);
    const double cursorVY = finiteOr(stroke.vy, 0.0);
    const double rawCursorSpeed = std::hypot(cursorVX, cursorVY);
    double cursorUnitX;
    double cursorUnitY;
    double cursorSpeed;
    if (rawCursorSpeed > 1e-8) {
        cursorUnitX = cursorVX / rawCursorSpeed;
        cursorUnitY = cursorVY / rawCursorSpeed;
        cursorSpeed = std::min(rawCursorSpeed, MaxCursorSpeed);
    } else {
        cursorUnitX = segmentX / travel;
        cursorUnitY = segmentY / travel;
        cursorSpeed = std::min(travel * 60.0, MaxCursorSpeed);
    }

    const double radiusSq = radius * radius;
    const double flowImpulse = std::min(0.75, travel * FlowImpulsePerUnit)
        * (0.45 + 0.55 * cursorSpeed / MaxCursorSpeed) * strength;

    if (boundsDirty_) {
        for (std::size_t start = 0, block = 0; start < count; start += BlockSize, block += 4) {
            float minX = std::numeric_limits<float>::infinity();
            float minY = std::numeric_limits<float>::infinity();
            float maxX = -std::numeric_limits<float>::infinity();
            float maxY = -std::numeric_limits<float>::infinity();
            const std::size_t end = std::min(count, start + BlockSize);
            for (std::size_t offset = start * 3; offset < end * 3; offset += 3) {
                const double sum = static_cast<double>(positions[offset]) + positions[offset + 1] + positions[offset + 2]
                    + velocities[offset] + velocities[offset + 1] + velocities[offset + 2];
                if (!std::isfinite(sum)) {
                    minX = minY = -std::numeric_limits<float>::infinity();
                    maxX = maxY = std::numeric_limits<float>::infinity();
                    break;
                }
                minX = std::min(minX, positions[offset]);
                minY = std::min(minY, positions[offset + 1]);
                maxX = std::max(maxX, positions[offset]);
                maxY = std::max(maxY, positions[offset + 1]);
            }
            bounds_[block] = minX;
            bounds_[block + 1] = minY;
            bounds_[block + 2] = maxX;
            bounds_[block + 3] = maxY;
        }
        boundsDirty_ = false;
    }

    const double left = std::min(fromX, toX) - radius;
    const double right = std::max(fromX, toX) + radius;
    const double bottom = std::min(fromY, toY) - radius;
    const double top = std::max(fromY, toY) + radius;
    for (std::size_t start = 0, block = 0; start < count; start += BlockSize, block += 4) {
        if (bounds_[block] > right || bounds_[block + 2] < left
            || bounds_[block + 1] > top || bounds_[block + 3] < bottom) continue;
        const std::size_t end = std::min(count, start + BlockSize);
        for (std::size_t index = start, offset = start * 3; index < end; ++index, offset += 3) {
            double x = positions[offset];
            double y = positions[offset + 1];
            double vx = velocities[offset];
            double vy = velocities[offset + 1];
            double vz = velocities[offset + 2];
            const double sum = x + y + positions[offset + 2] + vx + vy + vz;
            if (!std::isfinite(sum)) {
                x = homes[offset];
                y = homes[offset + 1];
                positions[offset] = homes[offset];
                positions[offset + 1] = homes[offset + 1];
                positions[offset + 2] = homes[offset + 2];
                vx = vy = vz = 0.0;
                velocities[offset] = velocities[offset + 1] = velocities[offset + 2] = 0.0f;
            }

            double closestT = ((x - fromX) * segmentX + (y - fromY) * segmentY) / segmentLengthSq;
            closestT = clamp(closestT, 0.0, 1.0);
            const double distanceX = x - (fromX + segmentX * closestT);
            const double distanceY = y - (fromY + segmentY * closestT);
            const double distanceSq = distanceX * distanceX + distanceY * distanceY;
            if (!(distanceSq < radiusSq)) continue;

            const double qx = distanceX / radius;
            const double qy = distanceY / radius;
            const double edge = 1.0 - distanceSq / radiusSq;
            const double weight = edge * edge * edge;
            const double along = qx * cursorUnitX + qy * cursorUnitY;
            const double across = -qx * cursorUnitY + qy * cursorUnitX;
            const double curl = flow_[offset];
            const double carry = 0.8 - 1.6 * across * across;
            const double crossFlow = 1.5 * along * across;
            const double perpendicularX = -cursorUnitY;
            const double perpendicularY = cursorUnitX;
            const double variation = flow_[offset + 1];
            const double inverseMass = 1.0 / masses[index];
            vx += flowImpulse * weight * variation * inverseMass
                * (cursorUnitX * carry + perpendicularX * crossFlow - qy * curl * 2.8);
            vy += flowImpulse * weight * variation * inverseMass
                * (cursorUnitY * carry + perpendicularY * crossFlow + qx * curl * 2.8);
            vz += flowImpulse * weight * inverseMass * flow_[offset + 2];

            const double speedSq = vx * vx + vy * vy + vz * vz;
            if (speedSq > MaxSpeed * MaxSpeed) {
                const double scale = MaxSpeed / std::sqrt(speedSq);
                vx *= scale;
                vy *= scale;
                vz *= scale;
            }
            velocities[offset] = static_cast<float>(vx);
            velocities[offset + 1] = static_cast<float>(vy);
            velocities[offset + 2] = static_cast<float>(vz);
        }
    }
}

void Physics::step(double dt) {
    const std::size_t count = homes.size() / 3;
    dt = finiteOr(dt, 0.0);
    if (dt <= 0.0 || count == 0) return;
    dt = std::min(dt, MaxDt);
    boundsDirty_ = true;

    std::array<double, 5> cosines{};
    std::array<double, 5> envelopes{};
    std::array<double, 5> decays{};
    std::array<double, 5> sineOverOmegas{};
    for (std::size_t sizeClass = 0; sizeClass < ParticleSizes.size(); ++sizeClass) {
        const double size = ParticleSizes[sizeClass];
        const double decay = damping_ * 0.5 / size;
        const double frequencySq = spring_ / (size * size) - decay * decay;
        const double envelope = std::exp(-decay * dt);
        decays[sizeClass] = decay;
        envelopes[sizeClass] = envelope;
        if (std::abs(frequencySq) < 1e-8) {
            cosines[sizeClass] = 1.0;
            sineOverOmegas[sizeClass] = dt;
        } else if (frequencySq > 0.0) {
            const double omega = std::sqrt(frequencySq);
            cosines[sizeClass] = std::cos(omega * dt);
            sineOverOmegas[sizeClass] = std::sin(omega * dt) / omega;
        } else {
            const double omega = std::sqrt(-frequencySq);
            cosines[sizeClass] = std::cosh(omega * dt);
            sineOverOmegas[sizeClass] = std::sinh(omega * dt) / omega;
        }
    }

    for (std::size_t index = 0, offset = 0; index < count; ++index, offset += 3) {
        const double homeX = homes[offset];
        const double homeY = homes[offset + 1];
        const double homeZ = homes[offset + 2];
        double x = positions[offset];
        double y = positions[offset + 1];
        double z = positions[offset + 2];
        double vx = velocities[offset];
        double vy = velocities[offset + 1];
        double vz = velocities[offset + 2];
        if (x == homeX && y == homeY && z == homeZ && vx == 0.0 && vy == 0.0 && vz == 0.0) continue;

        const double restDistanceSq = (x - homeX) * (x - homeX) + (y - homeY) * (y - homeY) + (z - homeZ) * (z - homeZ);
        if (restDistanceSq < 1e-12 && vx * vx + vy * vy + vz * vz < 1e-12) {
            positions[offset] = homes[offset];
            positions[offset + 1] = homes[offset + 1];
            positions[offset + 2] = homes[offset + 2];
            velocities[offset] = velocities[offset + 1] = velocities[offset + 2] = 0.0f;
            continue;
        }
        if (!std::isfinite(x + y + z + vx + vy + vz)) {
            x = homeX;
            y = homeY;
            z = homeZ;
            vx = vy = vz = 0.0;
        }

        const double displacementX = x - homeX;
        const double displacementY = y - homeY;
        const double displacementZ = z - homeZ;
        const std::uint8_t sizeClass = sizeClasses[index];
        const double cosine = cosines[sizeClass];
        const double envelope = envelopes[sizeClass];
        const double decay = decays[sizeClass];
        const double sineOverOmega = sineOverOmegas[sizeClass];
        const double springAcceleration = spring_ / masses[index];

        double nextX = envelope * (displacementX * cosine + (vx + decay * displacementX) * sineOverOmega);
        double nextY = envelope * (displacementY * cosine + (vy + decay * displacementY) * sineOverOmega);
        double nextZ = envelope * (displacementZ * cosine + (vz + decay * displacementZ) * sineOverOmega);
        double nextVX = envelope * (vx * cosine - (decay * vx + springAcceleration * displacementX) * sineOverOmega);
        double nextVY = envelope * (vy * cosine - (decay * vy + springAcceleration * displacementY) * sineOverOmega);
        double nextVZ = envelope * (vz * cosine - (decay * vz + springAcceleration * displacementZ) * sineOverOmega);

        const double speedSq = nextVX * nextVX + nextVY * nextVY + nextVZ * nextVZ;
        if (speedSq > MaxSpeed * MaxSpeed) {
            const double scale = MaxSpeed / std::sqrt(speedSq);
            nextVX *= scale;
            nextVY *= scale;
            nextVZ *= scale;
        }
        const double displacementSq = nextX * nextX + nextY * nextY + nextZ * nextZ;
        if (displacementSq > MaxDisplacement * MaxDisplacement) {
            const double scale = MaxDisplacement / std::sqrt(displacementSq);
            nextX *= scale;
            nextY *= scale;
            nextZ *= scale;
        }

        positions[offset] = static_cast<float>(homeX + nextX);
        positions[offset + 1] = static_cast<float>(homeY + nextY);
        positions[offset + 2] = static_cast<float>(homeZ + nextZ);
        velocities[offset] = static_cast<float>(nextVX);
        velocities[offset + 1] = static_cast<float>(nextVY);
        velocities[offset + 2] = static_cast<float>(nextVZ);
    }
}

void Physics::reset() {
    boundsDirty_ = true;
    positions = homes;
    std::fill(velocities.begin(), velocities.end(), 0.0f);
}

Sampler::Sampler(int hz)
    : hz_(hz), intervalMs_(1000.0 / hz), rawX_(RawCapacity), rawY_(RawCapacity), rawTime_(RawCapacity) {
    if (!supportedRate(hz)) {
        throw std::invalid_argument("Interaction sampling rate must be 30, 60, 120, or 240 Hz");
    }
}

void Sampler::reset() {
    rawStart_ = 0;
    rawCount_ = 0;
    initialized_ = false;
    sampleX_ = sampleY_ = sampleTime_ = nextTime_ = lastRawTime_ = observedRawGapMs_ = 0.0;
    hasRawSegment_ = false;
}

void Sampler::push(double x, double y, double timeMs) {
    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(timeMs)) {
        reset();
        return;
    }
    if (initialized_ && (timeMs < lastRawTime_ || timeMs - lastRawTime_ > StaleMs)) reset();
    if (!initialized_) {
        initialized_ = true;
        sampleX_ = x;
        sampleY_ = y;
        sampleTime_ = timeMs;
        nextTime_ = timeMs + intervalMs_;
        lastRawTime_ = timeMs;
        appendRaw(x, y, timeMs);
        return;
    }
    if (timeMs == lastRawTime_) {
        const int index = (rawStart_ + rawCount_ - 1) % RawCapacity;
        rawX_[index] = x;
        rawY_[index] = y;
        return;
    }
    const double rawGapMs = timeMs - lastRawTime_;
    observedRawGapMs_ = observedRawGapMs_ == 0.0 ? rawGapMs : std::max(rawGapMs, observedRawGapMs_ * 0.8);
    hasRawSegment_ = true;
    lastRawTime_ = timeMs;
    appendRaw(x, y, timeMs);
}

void Sampler::drain(double nowMs, const std::function<void(const Stroke&)>& callback, int limit) {
    if (!callback) throw std::invalid_argument("callback must be callable");
    if (!initialized_ || !std::isfinite(nowMs) || limit <= 0) return;
    if (nowMs - lastRawTime_ > StaleMs) {
        reset();
        return;
    }

    const int callbackLimit = std::max(0, limit);
    int emitted = 0;
    int iterations = 0;
    const int maxIterations = callbackLimit + 64;
    while (emitted < callbackLimit && iterations < maxIterations) {
        const double targetTime = nextTime_;
        bool allowHeldEndpoint = false;
        if (targetTime > lastRawTime_ + TimeEpsilonMs) {
            if (!hasRawSegment_) break;
            const double endpointWaitMs = std::min(MaxEndpointWaitMs, std::max(intervalMs_, observedRawGapMs_ * 1.5));
            if (nowMs - lastRawTime_ + TimeEpsilonMs < endpointWaitMs || targetTime > nowMs + TimeEpsilonMs) break;
            allowHeldEndpoint = true;
        }

        double toX;
        double toY;
        if (allowHeldEndpoint) {
            const int latest = (rawStart_ + rawCount_ - 1) % RawCapacity;
            toX = rawX_[latest];
            toY = rawY_[latest];
        } else {
            discardBefore(targetTime);
            const int first = rawStart_;
            if (rawCount_ == 1) {
                toX = rawX_[first];
                toY = rawY_[first];
            } else {
                const int second = (first + 1) % RawCapacity;
                const double fromTime = rawTime_[first];
                const double duration = rawTime_[second] - fromTime;
                const double alpha = duration > 0.0 ? clamp((targetTime - fromTime) / duration, 0.0, 1.0) : 1.0;
                toX = rawX_[first] + (rawX_[second] - rawX_[first]) * alpha;
                toY = rawY_[first] + (rawY_[second] - rawY_[first]) * alpha;
            }
        }

        const double fromX = sampleX_;
        const double fromY = sampleY_;
        const double dx = toX - fromX;
        const double dy = toY - fromY;
        const double elapsedSeconds = std::max((targetTime - sampleTime_) / 1000.0, 1e-9);
        sampleX_ = toX;
        sampleY_ = toY;
        sampleTime_ = targetTime;
        nextTime_ = targetTime + intervalMs_;
        ++iterations;
        if (dx * dx + dy * dy <= PositionEpsilonSq) continue;

        double vx = dx / elapsedSeconds;
        double vy = dy / elapsedSeconds;
        const double speed = std::hypot(vx, vy);
        if (speed > SamplerMaxSpeed) {
            const double scale = SamplerMaxSpeed / speed;
            vx *= scale;
            vy *= scale;
        }
        sample_.fromX = fromX;
        sample_.fromY = fromY;
        sample_.toX = toX;
        sample_.toY = toY;
        sample_.vx = vx;
        sample_.vy = vy;
        sample_.radius = 0.0;
        sample_.strength = 0.0;
        callback(sample_);
        ++emitted;
    }
}

void Sampler::appendRaw(double x, double y, double timeMs) {
    if (rawCount_ == RawCapacity) {
        for (int i = 1; i < rawCount_ - 1; ++i) {
            const int from = (rawStart_ + i + 1) % RawCapacity;
            const int to = (rawStart_ + i) % RawCapacity;
            rawX_[to] = rawX_[from];
            rawY_[to] = rawY_[from];
            rawTime_[to] = rawTime_[from];
        }
        --rawCount_;
    }
    const int index = (rawStart_ + rawCount_) % RawCapacity;
    rawX_[index] = x;
    rawY_[index] = y;
    rawTime_[index] = timeMs;
    ++rawCount_;
}

void Sampler::discardBefore(double targetTime) {
    while (rawCount_ > 1) {
        const int second = (rawStart_ + 1) % RawCapacity;
        if (rawTime_[second] + TimeEpsilonMs >= targetTime) break;
        rawStart_ = second;
        --rawCount_;
    }
}

} // namespace painting
