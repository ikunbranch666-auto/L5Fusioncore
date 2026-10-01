#!/usr/bin/env python
# Sample screen color at fragment positions across exp4 shots.
from PIL import Image
import json, os
base='E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/shots/'
pos=json.load(open('E:/coding/NodeDesign/l5-core-showcase/investigation/C_emp/csv/hit_pos.json'))
b3=next(p for p in pos if p['i']==144)
inn=next(p for p in pos if p['i']==0)
def samp(path, x, y):
    im=Image.open(path).convert('RGB'); px=im.load()
    # 5x5 average
    rs=gs=bs=n=0
    for dy in range(-3,4):
        for dx in range(-3,4):
            r,g,b=px[min(max(x+dx,0),im.width-1), min(max(y+dy,0),im.height-1)]
            rs+=r; gs+=g; bs+=b; n+=1
    return (rs//n, gs//n, bs//n)
shots=['t0_cool0','t_2_b3only','t_4_b3only','t_6_b3only']
print(f"{'state':16s} {'b3#144@(719,474) RGB':24s} {'inner#0@(676,329) RGB':24s}")
for s in shots:
    p=base+'exp4_'+s+'.png'
    if not os.path.exists(p): print(s,'MISSING'); continue
    cb=samp(p, int(b3['sx']), int(b3['sy']))
    ci=samp(p, int(inn['sx']), int(inn['sy']))
    print(f"{s:16s} {str(cb):24s} {str(ci):24s}")
