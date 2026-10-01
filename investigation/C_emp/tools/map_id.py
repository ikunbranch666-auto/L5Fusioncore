#!/usr/bin/env python
# Map white pixels -> fragment identity.
# Usage: python map_id.py <shot.png> <frags.json> [out.csv]
# White criterion: lum>150 & R>140 & B>140. Sampling region x[0.18,0.60]w y[0.15,0.80]h.
import sys, json, math, csv
from PIL import Image

shot, fj = sys.argv[1], sys.argv[2]
outcsv = sys.argv[3] if len(sys.argv)>3 else None

im = Image.open(shot).convert('RGB')
W,H = im.size
px = im.load()
data = json.load(open(fj))
frags = data['frags']

x0,x1 = int(W*0.18), int(W*0.60)
y0,y1 = int(H*0.15), int(H*0.80)

# collect white pixel coords (step 1 for clustering; the % uses step3 separately)
white_pts = []
white_mask = set()
for y in range(y0,y1):
    for x in range(x0,x1):
        r,g,b = px[x,y]
        lum = 0.299*r+0.587*g+0.114*b
        if lum>150 and r>140 and b>140:
            white_pts.append((x,y))
            white_mask.add((x,y))

# connected components (8-neigh) via BFS
visited=set()
comps=[]
for pt in white_pts:
    if pt in visited: continue
    stack=[pt]; visited.add(pt); comp=[]
    while stack:
        x,y = stack.pop(); comp.append((x,y))
        for dx in (-1,0,1):
            for dy in (-1,0,1):
                if dx==0 and dy==0: continue
                nb=(x+dx,y+dy)
                if nb in white_mask and nb not in visited:
                    visited.add(nb); stack.append(nb)
    if len(comp)>=3:
        comps.append(comp)

# assign each comp to nearest fragment screen point
def nearest_frag(cx,cy):
    best=None; bd=1e9
    for f in frags:
        d = math.hypot(f['sx']-cx, f['sy']-cy)
        if d<bd: bd=d; best=f
    return best,bd

rows=[]
print(f"shot={shot} size={W}x{H} white_px={len(white_pts)} comps={len(comps)}")
for comp in sorted(comps, key=len, reverse=True):
    n=len(comp)
    cx=sum(p[0] for p in comp)/n; cy=sum(p[1] for p in comp)/n
    f,d = nearest_frag(cx,cy)
    rows.append({
        'cluster_px': n, 'cx': round(cx,1), 'cy': round(cy,1),
        'dist_to_frag_px': round(d,1),
        'frag_i': f['i'], 'band': f['band'], 'faceIdx': f['faceIdx'],
        'stored': f['stored'], 'u_cool': f['u_cool'], 'radialN': f['radialN'],
        'frag_sx': f['sx'], 'frag_sy': f['sy'], 'behind': f['behind'],
    })
    print(f"  n={n:4d} center=({cx:.0f},{cy:.0f}) -> frag#{f['i']} band={f['band']} "
          f"stored={f['stored']} u_cool={f['u_cool']} radialN={f['radialN']} d={d:.0f}px behind={f['behind']}")

if outcsv:
    with open(outcsv,'w',newline='') as fh:
        w=csv.DictWriter(fh, fieldnames=list(rows[0].keys()) if rows else ['cluster_px'])
        w.writeheader(); w.writerows(rows)
    print("wrote", outcsv)
