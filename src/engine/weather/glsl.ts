// 天気モジュール共通の GLSL 片。各シェーダ文字列に ${WX_COMMON} で埋め込む（チャンク登録はしない＝他モジュールと衝突しない）。
// 必要な uniforms は WeatherUniforms（index.ts）が持つ。env.uniforms とは別に、同じ参照で天気の全マテリアルに配る。

export const WX_COMMON = /* glsl */ `
#ifndef WX_COMMON_INCLUDED
#define WX_COMMON_INCLUDED
uniform sampler2D tWxDepth;     // 線形深度（pipeline.copyDepthRT、R32F）
uniform vec2 uWxResolution;     // 描画バッファの実サイズ
uniform vec2 uWxNearFar;        // camera near / far
uniform float uWxPixel;         // 1ピクセルの見込み角（rad）。距離 × これ = その距離での1pxの大きさ(m)
uniform vec4 uWxFog;            // x = 地表霧の量 0..1, y = 霧のスケール高さ(m), z = 霧の上端(world y), w = 雨のヴェール係数(1/m)
uniform vec3 uWxFogDrift;       // 霧のむらの流れ（m、風で進む）
uniform float uWxLake;          // 湖面の高さ
uniform float uWxCloudBase;     // 稲妻の上端（雲底）の高さ
const float WX_FOG_K = 0.12;    // 地表霧 量1・湖面での消散係数 (1/m)。層の中の視程 ~25m

float wx_linearDepth(float z){
  float n = uWxNearFar.x, f = uWxNearFar.y;
  float ndc = z * 2.0 - 1.0;
  return (2.0 * n * f) / (f + n - ndc * (f - n));
}
float wx_sceneDepth(vec2 fragCoord){ return texture2D(tWxDepth, fragCoord / uWxResolution).r; }
// ソフトパーティクル: 手前の物との深度差が range(m) 未満なら薄くする（地面にめり込む縁を消す）
float wx_soft(vec2 fragCoord, float fragZ, float range){
  float s = wx_sceneDepth(fragCoord);
  float d = wx_linearDepth(fragZ);
  return clamp((s - d) / range, 0.0, 1.0);
}
// Henyey-Greenstein 位相関数（c = cosθ, g = 異方性）
float wx_phaseHG(float c, float g){
  float k = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (12.566 * k * sqrt(max(k, 1e-4)));
}
// 地表霧の光学的厚さ（解析、むら無しの平均）。a → b の線分。粒子や雨が霧に沈む量に使う
float wx_fogOD(vec3 a, vec3 b){
  vec3 d = b - a;
  float L = length(d);
  if (L < 1e-3 || uWxFog.x < 1e-4) return 0.0;
  float dy = d.y / L;
  float Hs = uWxFog.y;
  float y0 = max(a.y - uWxLake, 0.0);
  float y1 = max(b.y - uWxLake, 0.0);
  float integral;
  if (abs(dy) < 1e-3) integral = L * exp(-y0 / Hs);
  else integral = (Hs / dy) * (exp(-y0 / Hs) - exp(-y1 / Hs));
  integral = max(integral, 0.0);
  return integral * uWxFog.x * WX_FOG_K * 0.5;
}
// 雨のヴェール（遠くほど雨粒の層で白む）の光学的厚さ
float wx_veilOD(float dist){ return dist * uWxFog.w; }
// カメラの右・上・前（viewMatrix から）
vec3 wx_camRight(mat4 v){ return vec3(v[0][0], v[1][0], v[2][0]); }
vec3 wx_camUp(mat4 v){ return vec3(v[0][1], v[1][1], v[2][1]); }
vec3 wx_camFwd(mat4 v){ return -vec3(v[0][2], v[1][2], v[2][2]); }
#endif
`;

/** カメラの視線レイをフルスクリーン三角形で出す頂点シェーダ（vRay は view z=-1 あたりの world ベクトル。線形深度を掛ければ world 位置） */
export const WX_FS_VERT = /* glsl */ `
uniform mat4 uWxInvProj;
uniform mat4 uWxCamWorld;
varying vec2 vUv;
varying vec3 vRay;
void main(){
  vUv = uv;
  vec4 p = uWxInvProj * vec4(position.xy, 1.0, 1.0);
  vec3 v = p.xyz / p.w;
  v /= -v.z;
  vRay = (uWxCamWorld * vec4(v, 0.0)).xyz;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** 頂点シェーダ用の裏返しマスク（flip_flip チャンクは fwidth を含み頂点では使えないので、同じ式をここに持つ） */
export const WX_FLIP_VS = /* glsl */ `
#ifndef WX_FLIP_VS_INCLUDED
#define WX_FLIP_VS_INCLUDED
uniform float uFlip;
uniform vec3 uFlipCenter;
uniform float uFlipRadius;
uniform float uTime;
float wx_flipMask(vec3 worldPos){
  float d = distance(worldPos, uFlipCenter);
  float edge = 40.0;
  float wave = 1.0 - smoothstep(uFlipRadius - edge, uFlipRadius + edge, d);
  return clamp(wave * step(0.001, uFlipRadius), 0.0, 1.0);
}
#endif
`;

/** 板（インスタンス）の共通: position は x∈[-0.5,0.5], y∈[0,1] の四角 */
export const WX_QUAD_ATTR = /* glsl */ `
attribute vec4 aSeed;
attribute float aIndex;
`;
