#!/usr/bin/env python
# Sample the brightest pixels in the measurement region, print their RGB distribution.
import sys
from PIL import Image
from collections import Counter

path = sys.argv[1] if len(sys.argv)>1 else 'shots/probe_p05.png'
im = Image.open(path).convert('RGB')
W,H = im.size
px = im.load()
x0,x1 = int(W*0.18), int(W*0.60)
y0,y1 = int(H*0.15), int(H*0.80)

# collect all bright pixels (lum>100), histogram their rounded color
buckets = Counter()
whites = []
for y in range(y0,y1,1):
    for x in range(x0,x1,1):
        r,g,b = px[x,y]
        lum = 0.299*r+0.587*g+0.114*b
        if lum > 120:
            # quantize to 16-step bins
            buckets[(r//16*16, g//16*16, b//16*16)] += 1
        if lum>150 and r>140 and b>140:
            whites.append((r,g,b))

print(f"file={path} size={W}x{H}")
print(f"--- top color buckets among lum>120 (rgb bin -> count) ---")
for col,cnt in buckets.most_common(15):
    print(f"  rgb~{col}  n={cnt}")
print(f"--- white pixels (lum>150,R>140,B>140): {len(whites)} ---")
if whites:
    rs=[w[0] for w in whites]; gs=[w[1] for w in whites]; bs=[w[2] for w in whites]
    print(f"  mean RGB = ({sum(rs)/len(rs):.0f},{sum(gs)/len(gs):.0f},{sum(bs)/len(bs):.0f})")
    print(f"  min/max R = {min(rs)}/{max(rs)}  B={min(bs)}/{max(bs)}")
    # histogram of white pixel R
    rb = Counter(w[0]//16*16 for w in whites)
    print("  R histogram:", dict(sorted(rb.items())))
    gb = Counter(w[1]//16*16 for w in whites)
    print("  G histogram:", dict(sorted(gb.items())))
    bb = Counter(w[2]//16*16 for w in whites)
    print("  B histogram:", dict(sorted(bb.items())))
