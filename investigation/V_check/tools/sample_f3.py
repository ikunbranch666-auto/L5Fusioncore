# Sample 7x7 patch at pick coords across F3 ramp screenshots. Reads f3_v.json for pick coords.
import json, os
from PIL import Image
ROOT = r"E:\coding\NodeDesign\l5-core-showcase\investigation\V_check"
meta = json.load(open(os.path.join(ROOT, "f3_v.json")))
sx, sy = meta["pick"]["sx"], meta["pick"]["sy"]
print(f"pick fragment #{meta['pick']['i']} band={meta['pick']['band']} screen=({sx},{sy})")
for st in [0,2,4,6]:
    p = os.path.join(ROOT, "shots", f"f3_stored{st}.png")
    im = Image.open(p).convert("RGB")
    px = [im.getpixel((sx+dx, sy+dy)) for dx in range(-3,4) for dy in range(-3,4)]
    r = sum(q[0] for q in px)//len(px)
    g = sum(q[1] for q in px)//len(px)
    b = sum(q[2] for q in px)//len(px)
    lum = 0.299*r+0.587*g+0.114*b
    print(f"  stored={st} 7x7avg RGB=({r},{g},{b}) lum={lum:.0f} white(R>140&B>140)={r>140 and b>140}")
