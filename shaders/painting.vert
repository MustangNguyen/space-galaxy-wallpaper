#version 300 es
precision highp float;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
in vec3 position;

    uniform float uSize;
    uniform float uWaterTime;
    uniform float uHaloScale;
    in float aSize;
    in vec3 aColor;
    in vec3 aHome;
    in vec3 aVelocity;
    out vec3 vColor;
    out float vDepth;
    out float vFocus;
    out float vEnergy;
    void main() {
      // Small travelling waves live on the GPU. Anchor their phase to each
      // home so a mouse stroke blends into the surface without phase jumps.
      float swell = sin(aHome.x * 6.0 + aHome.y * 4.0 - uWaterTime * 0.9);
      float crossWave = sin(-aHome.x * 3.0 + aHome.y * 7.0 + uWaterTime * 0.65);
      float ripple = sin(aHome.x * 11.0 - aHome.y * 5.0 - uWaterTime * 1.15);
      vec3 water = vec3(
        0.006 * swell + 0.003 * crossWave,
        0.005 * crossWave + 0.002 * ripple,
        0.012 * swell + 0.007 * crossWave
      );
      vec3 surfacePosition = position + water;
      vDepth = clamp(surfacePosition.z * 2.0, -0.3, 0.3);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(surfacePosition, 1.0);
      float speed = length(aVelocity.xy);
      vEnergy = smoothstep(0.015, 0.55, speed);
      vFocus = smoothstep(0.12, 0.78, dot(aColor, vec3(0.2126, 0.7152, 0.0722)));
      gl_PointSize = uSize * aSize * (1.0 + vDepth) * uHaloScale * (1.0 + 0.12 * vEnergy);
      vColor = aColor;
    }
