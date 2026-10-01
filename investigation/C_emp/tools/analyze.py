#!/usr/bin/env python
# White-block analyzer.
# Usage: python analyze.py <png> [--grid COLSxROWS] [--out-csv row.csv]
# Criterion (per morning baseline): lum>150 AND R>140 AND B>140.
# Sampling region: x in [0.18,0.60] w, y in [0.15,0.80] h, step 3 px.
import sys, argparse, os
from PIL import Image

def analyze(path, grid_cols=24, grid_rows=16):
    im = Image.open(path).convert('RGB')
    W, H = im.size
    px = im.load()
    x0, x1 = int(W*0.18), int(W*0.60)
    y0, y1 = int(H*0.15), int(H*0.80)
    step = 3
    tot = 0; white = 0
    rs=gs=bs=0.0
    # grid cell counters
    gw = (x1-x0); gh = (y1-y0)
    cell_w = gw/grid_cols; cell_h = gh/grid_rows
    grid_white = [[0]*grid_cols for _ in range(grid_rows)]
    grid_tot = [[0]*grid_cols for _ in range(grid_rows)]
    for y in range(y0, y1, step):
        for x in range(x0, x1, step):
            r,g,b = px[x,y]
            tot += 1
            rs+=r; gs+=g; bs+=b
            lum = 0.299*r+0.587*g+0.114*b
            is_white = (lum>150 and r>140 and b>140)
            if is_white: white += 1
            c = min(grid_cols-1, int((x-x0)/cell_w))
            rr = min(grid_rows-1, int((y-y0)/cell_h))
            grid_tot[rr][c]+=1
            if is_white: grid_white[rr][c]+=1
    pct = 100.0*white/tot if tot else 0
    print(f"file: {os.path.basename(path)}  size={W}x{H}")
    print(f"sample region: x[{x0},{x1}] y[{y0},{y1}]  sampled={tot}")
    print(f"avg RGB = ({rs/tot:.0f},{gs/tot:.0f},{bs/tot:.0f})")
    print(f"WHITE = {white}  ({pct:.3f}%)")
    # ascii grid: each cell density of white
    print("ASCII grid (rows top->bottom, cols left->right; # >25% white, + 5-25%, . 1-5%, space <1%):")
    chars = " .+*#"
    for rr in range(grid_rows):
        line=""
        for c in range(grid_cols):
            d = grid_white[rr][c]/grid_tot[rr][c] if grid_tot[rr][c] else 0
            idx = 0 if d<0.01 else 1 if d<0.05 else 2 if d<0.15 else 3 if d<0.30 else 4
            line += chars[idx]
        print(line)
    return pct

if __name__=='__main__':
    ap=argparse.ArgumentParser()
    ap.add_argument('png')
    ap.add_argument('--grid', default='24x16')
    a=ap.parse_args()
    gc,gr = a.grid.split('x')
    analyze(a.png, int(gc), int(gr))
