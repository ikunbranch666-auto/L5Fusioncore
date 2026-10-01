#!/usr/bin/env python
# exp6: white% time series + cell persistence over 8 shots.
from PIL import Image
import glob, os
shots=sorted(glob.glob('E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/shots/exp6_t*.png'))
GC,GR=24,16
def white_cells(im):
    W,H=im.size; px=im.load()
    x0,x1=int(W*0.18),int(W*0.60); y0,y1=int(H*0.15),int(H*0.80)
    cw=(x1-x0)/GC; ch=(y1-y0)/GR
    cell_white=[[0]*GC for _ in range(GR)]
    cell_tot=[[0]*GC for _ in range(GR)]
    tot=w=0
    for y in range(y0,y1,2):
        for x in range(x0,x1,2):
            r,g,b=px[x,y]; tot+=1
            if 0.299*r+0.587*g+0.114*b>150 and r>140 and b>140:
                w+=1
                cc=min(GC-1,int((x-x0)/cw)); rr=min(GR-1,int((y-y0)/ch))
                cell_white[rr][cc]+=1
            cc=min(GC-1,int((x-x0)/cw)); rr=min(GR-1,int((y-y0)/ch))
            cell_tot[rr][cc]+=1
    return 100.0*w/tot, cell_white, cell_tot

presence=[[0]*GC for _ in range(GR)]  # how many shots each cell had white
pcts=[]
for i,s in enumerate(shots):
    im=Image.open(s).convert('RGB')
    pct,cw,ct=white_cells(im)
    pcts.append(pct)
    for r in range(GR):
        for c in range(GC):
            if ct[r][c] and cw[r][c]/ct[r][c]>0.04:  # cell considered white in this shot
                presence[r][c]+=1
print("white% over 8 samples:", " ".join(f"{p:.2f}" for p in pcts))
print(f"mean={sum(pcts)/len(pcts):.2f}%  min={min(pcts):.2f}  max={max(pcts):.2f}")
N=len(shots)
print(f"\nCell persistence map (over {N} samples):")
print("# = persistent white (>=6/8), + = intermittent (3-5), . = transient (1-2), space = never")
for r in range(GR):
    line=""
    for c in range(GC):
        pn=presence[r][c]
        line += '#' if pn>=6 else '+' if pn>=3 else '.' if pn>=1 else ' '
    print(line)
# count
persist=sum(1 for r in range(GR) for c in range(GC) if presence[r][c]>=6)
trans=sum(1 for r in range(GR) for c in range(GC) if 1<=presence[r][c]<=2)
inter=sum(1 for r in range(GR) for c in range(GC) if 3<=presence[r][c]<=5)
print(f"\npersistent cells(#)={persist}  intermittent(+)={inter}  transient(.)={trans}")
