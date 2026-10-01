#!/usr/bin/env python
# Aggregate white clusters -> per-band / per-cool buckets; rank fragments by whiteness.
import sys, json, csv
from collections import defaultdict

mapcsv, fj = sys.argv[1], sys.argv[2]
rows = list(csv.DictReader(open(mapcsv)))
data = json.load(open(fj))
frags = {f['i']: f for f in data['frags']}

band_px = defaultdict(int)
cool0_px = 0; coolpos_px = 0
per_frag_white = defaultdict(int)
for r in rows:
    n = int(r['cluster_px'])
    b = int(r['band'])
    band_px[b]+=n
    uc = float(r['u_cool'])
    if uc>0.01: coolpos_px+=n
    else: cool0_px+=n
    per_frag_white[int(r['frag_i'])]+=n

tot = sum(int(r['cluster_px']) for r in rows)
print(f"total white px in clusters: {tot}")
print("white px by band:", dict(sorted(band_px.items())))
print(f"white px on u_cool=0 frags: {cool0_px} ({100*cool0_px/tot:.1f}%)")
print(f"white px on u_cool>0 frags: {coolpos_px} ({100*coolpos_px/tot:.1f}%)")

# top 15 whitest fragments
print("\nTOP 15 whitest fragments:")
for fi,n in sorted(per_frag_white.items(), key=lambda x:-x[1])[:15]:
    f=frags[fi]
    print(f"  frag#{fi:3d} band={f['band']} stored={f['stored']:4.1f} u_cool={f['u_cool']:.2f} radialN={f['radialN']:.3f} whitePx={n}")

# band3 fragments sorted by stored desc; show their white px
print("\nband3 fragments sorted by stored (top 8) and their whiteness:")
b3 = [(fi,per_frag_white.get(fi,0)) for fi,f in frags.items() if f['band']==3]
b3.sort(key=lambda x: -frags[x[0]]['stored'])
for fi,w in b3[:8]:
    f=frags[fi]
    print(f"  frag#{fi:3d} stored={f['stored']:4.1f} u_cool={f['u_cool']:.2f} whitePx={w}")

# band3: highest stored but LOW white (user's "hit but won't whiten")
print("\nband3 with stored>=3 but whitePx<=2 (hit-but-not-white):")
for fi,w in sorted(b3, key=lambda x:-frags[x[0]]['stored']):
    f=frags[fi]
    if f['stored']>=3 and w<=2:
        print(f"  frag#{fi:3d} stored={f['stored']:4.1f} u_cool={f['u_cool']:.2f} whitePx={w}")
