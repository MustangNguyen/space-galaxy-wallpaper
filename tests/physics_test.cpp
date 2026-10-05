#include "physics.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {

void near(double actual, double expected, double tolerance, const char* label) {
    if (std::abs(actual - expected) > tolerance) {
        std::cerr << label << ": got " << actual << ", expected " << expected
                  << " +/- " << tolerance << '\n';
        std::abort();
    }
}

double distance(const painting::Physics& physics, std::size_t particle) {
    const std::size_t offset = particle * 3;
    return std::hypot(
        std::hypot(physics.positions[offset] - physics.homes[offset],
                   physics.positions[offset + 1] - physics.homes[offset + 1]),
        physics.positions[offset + 2] - physics.homes[offset + 2]);
}

void testConstructionAndReset() {
    painting::Physics p({-1.0f, 0.4f, 0.0f, 0.25f, -0.6f, 0.1f});
    assert((p.sizeClasses == std::vector<std::uint8_t>{2, 2}));
    assert((p.sizes == std::vector<float>{1.0f, 1.0f}));
    assert((p.masses == std::vector<float>{1.0f, 1.0f}));
    for (int i = 0; i < 1440; ++i) p.step(1.0 / 120.0);
    assert(p.positions == p.homes);
    assert(std::all_of(p.velocities.begin(), p.velocities.end(), [](float v) { return v == 0.0f; }));

    p.positions.assign(p.positions.size(), 4.0f);
    p.velocities.assign(p.velocities.size(), -3.0f);
    p.reset();
    assert(p.positions == p.homes);
    assert(std::all_of(p.velocities.begin(), p.velocities.end(), [](float v) { return v == 0.0f; }));

    bool threw = false;
    try { painting::Physics invalid({0.0f, 1.0f}); } catch (const std::invalid_argument&) { threw = true; }
    assert(threw);
    threw = false;
    try { painting::Physics invalid({0.0f, 0.0f, 0.0f}, {5}); } catch (const std::invalid_argument&) { threw = true; }
    assert(threw);
}

void testJsPhysicsFixture() {
    painting::Physics p({0.0f, 0.03f, 0.0f, 0.2f, -0.1f, 0.02f}, {0, 4});
    p.setDynamics(0.5, 0.2);
    p.disturb({-0.08, -0.01, 0.11, 0.04, 2.3, 0.7, 0.14, 0.8});
    for (int i = 0; i < 17; ++i) p.step(1.0 / 120.0);

    const std::vector<float> expectedPositions{
        0.0805540680885315f, 0.05499369278550148f, -0.008853141218423843f,
        0.20000000298023224f, -0.10000000149011612f, 0.019999999552965164f,
    };
    const std::vector<float> expectedVelocities{
        0.5518054366111755f, 0.17120996117591858f, -0.060645125806331635f, 0.0f, 0.0f, 0.0f,
    };
    for (std::size_t i = 0; i < p.positions.size(); ++i) {
        near(p.positions[i], expectedPositions[i], 2e-7, "JS position fixture");
        near(p.velocities[i], expectedVelocities[i], 2e-7, "JS velocity fixture");
    }
}

void testMassAndSpringExtremes() {
    painting::Physics p({0.0f, 0.03f, 0.0f, 0.0f, 0.03f, 0.0f}, {0, 4});
    p.disturb({-0.04, 0.0, 0.04, 0.0, 0.5, 0.0, 0.12, 0.1});
    const double small = std::hypot(std::hypot(p.velocities[0], p.velocities[1]), p.velocities[2]);
    const double large = std::hypot(std::hypot(p.velocities[3], p.velocities[4]), p.velocities[5]);
    near(small / large, p.masses[1] / p.masses[0], 1e-5, "mass impulse ratio");

    for (const auto dynamics : std::vector<std::pair<double, double>>{
             {0.5, 0.2}, {0.5, 6.0}, {20.0, 0.2}, {20.0, 6.0}, {4.0, 4.0}}) {
        painting::Physics q(std::vector<float>(15, 0.0f), {0, 1, 2, 3, 4});
        std::fill(q.positions.begin(), q.positions.end(), 0.1f);
        std::fill(q.velocities.begin(), q.velocities.end(), 0.2f);
        q.setDynamics(dynamics.first, dynamics.second);
        for (int i = 0; i < 1200; ++i) q.step(1.0 / 120.0);
        assert(std::all_of(q.positions.begin(), q.positions.end(), [](float v) { return std::isfinite(v); }));
        assert(std::all_of(q.velocities.begin(), q.velocities.end(), [](float v) { return std::isfinite(v); }));
        for (std::size_t i = 0; i < 5; ++i) assert(distance(q, i) <= 1.251);
    }
}

void testBoundsAndHostileInput() {
    std::vector<float> homes(1024 * 3);
    for (int i = 0; i < 1024; ++i) {
        homes[i * 3] = static_cast<float>((i % 32) / 16.0 - 1.0);
        homes[i * 3 + 1] = static_cast<float>((i / 32) / 16.0 - 1.0);
    }
    painting::Physics p(std::move(homes));
    p.disturb({-0.2, -0.6, -0.17, 0.6, 1.0, 2.0, 0.14, 1.0});
    int moved = 0;
    int untouched = 0;
    for (std::size_t i = 0; i < p.velocities.size() / 3; ++i) {
        const double speed = std::hypot(std::hypot(p.velocities[i * 3], p.velocities[i * 3 + 1]), p.velocities[i * 3 + 2]);
        if (speed > 0.0) ++moved; else ++untouched;
    }
    assert(moved > 0 && untouched > 0);

    p.positions[0] = std::numeric_limits<float>::infinity();
    p.velocities[1] = std::numeric_limits<float>::quiet_NaN();
    const double inf = std::numeric_limits<double>::infinity();
    const painting::Stroke hostile{-1e300, 1e300, 1e300, -1e300, inf, -inf, 1e300, 1e300};
    for (int i = 0; i < 120; ++i) {
        p.disturb(hostile);
        p.step(i & 1 ? 1e300 : 1.0 / 120.0);
    }
    assert(std::all_of(p.positions.begin(), p.positions.end(), [](float v) { return std::isfinite(v); }));
    assert(std::all_of(p.velocities.begin(), p.velocities.end(), [](float v) { return std::isfinite(v); }));
}

void testSamplerFixtureAndCadence() {
    painting::Sampler sampler(240);
    std::vector<painting::Stroke> output;
    sampler.push(0.0, 0.0, 0.0);
    sampler.push(0.3, 0.15, 10.0);
    sampler.push(0.7, -0.2, 31.0);
    sampler.drain(31.0, [&](const painting::Stroke& stroke) { output.push_back(stroke); });
    assert(output.size() == 7);
    const double expectedX[]{0.125, 0.25, 0.3476190476190476, 0.42698412698412697,
                             0.5063492063492063, 0.5857142857142857, 0.6650793650793652};
    const double expectedY[]{0.0625, 0.125, 0.10833333333333334, 0.038888888888888876,
                             -0.030555555555555614, -0.10000000000000006, -0.16944444444444448};
    for (std::size_t i = 0; i < output.size(); ++i) {
        near(output[i].toX, expectedX[i], 1e-12, "sampler fixture x");
        near(output[i].toY, expectedY[i], 1e-12, "sampler fixture y");
        assert(std::hypot(output[i].vx, output[i].vy) <= 12.0 + 1e-12);
        assert(output[i].radius == 0.0 && output[i].strength == 0.0);
    }

    int total = 0;
    painting::Sampler sustained(240);
    sustained.push(0.0, 0.0, 0.0);
    for (int frame = 1; frame <= 30; ++frame) {
        const double frameTime = frame * (1000.0 / 30.0);
        for (int event = (frame - 1) * 8 + 1; event <= frame * 8; ++event) {
            const double time = event * (1000.0 / 240.0);
            sustained.push(time / 1000.0, 0.0, time);
        }
        sustained.drain(frameTime, [&](const painting::Stroke&) { ++total; }, 32);
    }
    assert(total == 240);
}

void testSamplerEndpointAndStaleReset() {
    painting::Sampler sampler(120);
    int count = 0;
    painting::Stroke last;
    sampler.push(0.0, 0.0, 10.0);
    sampler.push(0.04, -0.02, 14.0);
    sampler.drain(14.0, [&](const painting::Stroke&) { ++count; });
    assert(count == 0);
    sampler.drain(24.0, [&](const painting::Stroke& s) { last = s; ++count; });
    assert(count == 1);
    near(last.toX, 0.04, 1e-15, "held endpoint x");

    sampler.reset();
    count = 0;
    sampler.push(0.0, 0.0, 0.0);
    sampler.push(1.0, 0.0, 4.0);
    sampler.drain(205.0, [&](const painting::Stroke&) { ++count; });
    assert(count == 0);
    sampler.push(10.0, 0.0, 300.0);
    sampler.push(20.0, 0.0, 250.0);
    sampler.push(21.0, 0.0, 260.0);
    sampler.drain(260.0, [&](const painting::Stroke& s) { last = s; ++count; });
    assert(count == 1);
    near(last.fromX, 20.0, 1e-15, "backwards reset origin");
}

} // namespace

int main() {
    testConstructionAndReset();
    testJsPhysicsFixture();
    testMassAndSpringExtremes();
    testBoundsAndHostileInput();
    testSamplerFixtureAndCadence();
    testSamplerEndpointAndStaleReset();
    std::cout << "physics/sampler tests passed\n";
}
