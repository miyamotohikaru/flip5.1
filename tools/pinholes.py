# 孤立高輝度画素（葉カードの白いピンホール）とマゼンタ画素を数える。
# 判定: 5x5 の局所中央値より +0.35 明るく、輝度 > 0.85 の画素。
import sys, numpy as np
from PIL import Image

def med5(a):
    h, w = a.shape
    p = np.pad(a, 2, mode="edge")
    st = np.lib.stride_tricks.sliding_window_view(p, (5, 5))
    return np.median(st.reshape(h, w, 25), axis=2)

for f in sys.argv[1:]:
    im = np.asarray(Image.open(f).convert("RGB")).astype(np.float32) / 255.0
    lum = 0.2126 * im[:, :, 0] + 0.7152 * im[:, :, 1] + 0.0722 * im[:, :, 2]
    m = med5(lum)
    pin = (lum - m > 0.35) & (lum > 0.85)
    r, g, b = im[:, :, 0], im[:, :, 1], im[:, :, 2]
    mag = (r > g + 0.06) & (b > g + 0.06) & (np.minimum(r, b) > 0.16) & (lum - m > 0.12)
    # 空・雲・太陽・水面は除外したいので、画面全体でなく「暗い近傍」を持つ孤立点だけ
    print(f"{f}: pinholes={int(pin.sum())} magenta={int(mag.sum())}")
