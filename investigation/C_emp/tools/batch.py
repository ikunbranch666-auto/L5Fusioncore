#!/usr/bin/env python
# Batch white-% analysis over matrix shots.
import sys, os
from PIL import Image
def white_pct(path):
    im=Image.open(path).convert('RGB'); W,H=im.size; px=im.load()
    x0,x1=int(W*0.18),int(W*0.60); y0,y1=int(H*0.15),int(H*0.80)
    tot=w=0
    for y in range(y0,y1,3):
        for x in range(x0,x1,3):
            r,g,b=px[x,y]; tot+=1
            if 0.299*r+0.587*g+0.114*b>150 and r>140 and b>140: w+=1
    return 100.0*w/tot, w, tot
shots=sys.argv[1]  # e.g. ../shots/p09_
conds=sys.argv[2].split(',')
for c in conds:
    p=f"{shots}{c}.png"
    if not os.path.exists(p):
        print(f"{c:14s} MISSING"); continue
    pct,w,t=white_pct(p)
    print(f"{c:14s} WHITE={w:4d} ({pct:6.3f}%)")
