#version 300 es
precision highp float;
out vec4 fragmentColor;

    uniform float uBrightness;
    in vec3 vColor;
    in float vDepth;
    in float vFocus;
    in float vEnergy;
    void main() {
      vec2 point = (gl_PointCoord - 0.5) * 2.0;
      float radiusSq = dot(point, point);
      if (radiusSq >= 1.0) discard;
      float coreRadiusSq = radiusSq * 4.84;
      float coreAlpha = 1.0 - smoothstep(0.27, 1.0, coreRadiusSq);
      float hotSpot = max(0.0, 1.0 - coreRadiusSq);
      hotSpot = hotSpot * hotSpot * hotSpot;
      vec3 light = mix(vColor, vec3(1.0), (0.015 + 0.10 * vFocus + 0.32 * vEnergy) * hotSpot);
      float halo = 1.0 - radiusSq;
      halo = halo * halo * halo;
      // Quiet shadows, luminous stars, and a brief glint as moving paint settles.
      light *= 0.72 + 0.42 * vFocus + 0.65 * vEnergy;
      vec3 emission = vColor * halo * (0.018 + 0.28 * vFocus * vFocus + 1.10 * vEnergy);
      fragmentColor = vec4((light * coreAlpha + emission) * (1.0 + vDepth * 0.35) * uBrightness, coreAlpha);
    }
