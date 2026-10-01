# Sample the white pixels' colors in a screenshot to characterize residual white source.
# Usage: python whitecolor.py <png>
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
W,H = im.size
px = im.load()
x0,x1,y0,y1 = int(W*0.18), int(W*0.60), int(H*0.15), int(H*0.80)
rs=gs=bs=0; n=0
rows=[]
for y in range(y0,y1,3):
    for x in range(x0,x1,3):
        r,g,b = px[x,y]
        lum = 0.299*r+0.587*g+0.114*b
        if lum>150 and r>140 and b>140:
            rs+=r; gs+=g; bs+=b; n+=1
            rows.append((x,y,r,g,b))
print(f"{sys.argv[1]}: white n={n} avgRGB=({rs//max(n,1)},{gs//max(n,1)},{bs//max(n,1)})")
# histogram of R and B
from collections import Counter
rc = Counter(min(180, (p[2]//10*10)) for p in rows)
print("R buckets:", dict(sorted(rc.items())))
bc = Counter(min(180, (p[4]//10*10)) for p in rows)
print("B buckets:", dict(sorted(bc.items())))
print("sample pixels (first 10):", rows[:10])
