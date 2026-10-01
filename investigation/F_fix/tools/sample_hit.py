from PIL import Image
import os
ROOT = r"E:\coding\NodeDesign\l5-core-showcase\investigation\F_fix"
sx, sy = 666, 299
print(f"sampling at ({sx},{sy}) across stored ramp:")
for st in [0,2,4,6]:
    p = os.path.join(ROOT, "shots", f"f3_hit_stored{st}.png")
    im = Image.open(p).convert("RGB")
    # average a 5x5 patch
    px = []
    for dx in range(-3,4):
        for dy in range(-3,4):
            px.append(im.getpixel((sx+dx, sy+dy)))
    r = sum(p[0] for p in px)//len(px)
    g = sum(p[1] for p in px)//len(px)
    b = sum(p[2] for p in px)//len(px)
    print(f"  stored={st}  RGB=({r},{g},{b})  lum={0.299*r+0.587*g+0.114*b:.0f}  white={r>140 and b>140}")
