// 植生モジュール共通の GLSL 断片。
//   - 頂点側: 風（向き・速さ・突風）、裏返しマスク（頂点シェーダでは flip_flip が使えない = fwidth を含むため）
//   - フラグメント側: CSM の影を「1回だけ」引いて、草・針葉・インポスターに共通の
//     包み込み拡散 + 逆光の透け（簡易 SSS）+ 半球光 を足す lights_fragment_begin の差し替え

/** 頂点シェーダ用。uniforms は env.uniforms（bindEnvUniforms で入る）。flip_noise を先に include すること。 */
export const VEG_VERT_COMMON = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uWind;
uniform float uLakeLevel;
uniform float uFlipRadius;
uniform vec3 uFlipCenter;
uniform float uTime;
// flip_flip と同じ式（頂点用）
float veg_flipMask(vec3 p){
  float d = distance(p, uFlipCenter);
  float w = 1.0 - smoothstep(uFlipRadius - 40.0, uFlipRadius + 40.0, d);
  return clamp(w * step(0.001, uFlipRadius), 0.0, 1.0);
}
vec2 veg_windDir(){ return normalize(uWind.xy + vec2(1e-4, 0.0)); }
// 突風。風下へ流れる大きなうねり（~60m）と中くらいの乱れ（~15m）。おおよそ 0..1.2
float veg_gust(vec2 xz){
  vec2 wd = veg_windDir();
  float sp = uWind.z;
  float t = uTime;
  float g1 = flip_gnoise(xz * 0.016 - wd * t * (0.7 + 0.3 * sp));
  float g2 = flip_gnoise(xz * 0.055 - wd * t * (1.4 + 0.4 * sp) + 7.3);
  return clamp(0.5 + 0.55 * g1 + 0.35 * g2, 0.0, 1.25);
}
// 画面座標のディザ（LOD のクロスフェード用、Interleaved Gradient Noise）
`;

/** フラグメントの LOD クロスフェード用ディザ。 */
export const VEG_FRAG_DITHER = /* glsl */ `
float veg_ign(vec2 px){ return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
`;

/**
 * lights_fragment_begin の差し替え。three.js の物理ライティングのうち「太陽（CSM）」だけを
 * 自前の包み込み拡散＋透けに置き換え、半球光はそのまま使う。
 * 呼ぶ前に float vegTrans（透けの強さ 0..1）と float vegAO（0..1）を定義しておくこと。
 * CSM の uniform（CSM_cascades / cameraNear / shadowFar）は patchMaterial({csm}) が入れる。
 */
export const VEG_LIGHTS_FRAGMENT = /* glsl */ `
vec3 geometryPosition = - vViewPosition;
vec3 geometryNormal = normal;
vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );
vec3 geometryClearcoatNormal = vec3( 0.0 );
IncidentLight directLight;
float vegShadow = 1.0;
#if defined( USE_SHADOWMAP ) && defined( USE_CSM ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
{
  float ld = vViewPosition.z / ( shadowFar - cameraNear );
  DirectionalLightShadow dls;
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
    if ( ld >= CSM_cascades[ i ].x && ( ld < CSM_cascades[ i ].y || UNROLLED_LOOP_INDEX == CSM_CASCADES - 1 ) ) {
      dls = directionalLightShadows[ i ];
      vegShadow = getShadow( directionalShadowMap[ i ], dls.shadowMapSize, dls.shadowIntensity, dls.shadowBias, dls.shadowRadius, vDirectionalShadowCoord[ i ] );
    }
  }
  #pragma unroll_loop_end
  vegShadow = receiveShadow ? vegShadow : 1.0;
}
#endif
#if NUM_DIR_LIGHTS > 0
{
  // 太陽（CSM の各カスケードは同じ向き・同じ色なので 0 番だけ見る）
  vec3 L = directionalLights[ 0 ].direction;
  vec3 sunCol = directionalLights[ 0 ].color * vegShadow;
  float NdotL = dot( geometryNormal, L );
  float wrap = 0.4;
  float diff = clamp( ( NdotL + wrap ) / ( 1.0 + wrap ), 0.0, 1.0 );
  // 逆光の透け: 視線の向こうに太陽があるほど強い。薄い葉ほど透ける
  float back = pow( clamp( dot( - geometryViewDir, L ), 0.0, 1.0 ), 3.0 );
  reflectedLight.directDiffuse += diffuseColor.rgb * RECIPROCAL_PI * sunCol * ( diff * vegAO + back * vegTrans * 1.4 );
}
#endif
#if NUM_DIR_LIGHTS > NUM_DIR_LIGHT_SHADOWS
{
  // 影を落とさない方向光（月）
  DirectionalLight moon = directionalLights[ NUM_DIR_LIGHTS - 1 ];
  float nl = clamp( ( dot( geometryNormal, moon.direction ) + 0.4 ) / 1.4, 0.0, 1.0 );
  reflectedLight.directDiffuse += diffuseColor.rgb * RECIPROCAL_PI * moon.color * nl * vegAO;
}
#endif
#if defined( RE_IndirectDiffuse )
vec3 iblIrradiance = vec3( 0.0 );
vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );
#if ( NUM_HEMI_LIGHTS > 0 )
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
    irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
  }
  #pragma unroll_loop_end
#endif
irradiance *= vegAO;
#endif
#if defined( RE_IndirectSpecular )
vec3 radiance = vec3( 0.0 );
vec3 clearcoatRadiance = vec3( 0.0 );
#endif
`;
