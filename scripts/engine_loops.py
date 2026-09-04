#!/usr/bin/env python3
"""Corta loops de motor por rango de rpm a partir de un onboard.

Uso: python3 scripts/engine_loops.py onboard.mp3 [--stints 109-784,804-892]

Requiere numpy, scipy y soundfile (pip install numpy scipy soundfile; el
libsndfile de soundfile decodifica mp3). Pasos:
1. Decodifica a mono 44,1 kHz.
2. Sigue la frecuencia de encendido (autocorrelación, 40-320 Hz) cada 50 ms.
3. Busca tramos de tono estable dentro de los "stints" (tramos en pista, en
   segundos) y elige uno por banda, "a fondo" (fuerte) y "levantado" (flojo).
4. Recorta un loop de ~0,75 s con un número entero de ciclos, promedia ciclos
   vecinos para bajar el viento, funde los extremos y normaliza.
Escribe public/audio/engine/*.wav (32 kHz mono) y src/game/engineLoops.ts.
"""
import numpy as np, json, os, sys
import soundfile as sf
from scipy.signal import butter, sosfiltfilt, resample_poly

if len(sys.argv) < 2:
    print(__doc__); sys.exit(1)
SRC = sys.argv[1]
STINTS = [(109, 784), (804, 892)]
if '--stints' in sys.argv:
    STINTS = [tuple(float(v) for v in s.split('-')) for s in sys.argv[sys.argv.index('--stints') + 1].split(',')]
OUT = "public/audio/engine"
os.makedirs(OUT, exist_ok=True)

# 1. Decodificar
d, sr0 = sf.read(SRC, always_2d=True)
m = d.mean(axis=1).astype(np.float32)
if sr0 != 44100:
    m = resample_poly(m, 44100, sr0).astype(np.float32)
sr = 44100
print(f"{SRC}: {len(m)/sr:.1f} s")

# 2. Seguimiento de tono
sos = butter(4, [40, 1200], btype='band', fs=sr, output='sos')
x = sosfiltfilt(sos, m)
N = 8192; hop = 2205
fmin, fmax = 40, 320
lagmin = int(sr / fmax); lagmax = int(sr / fmin)
res = []
win = np.hanning(N)
for s in range(0, len(x) - N, hop):
    fr = x[s:s + N] * win
    e = np.sqrt(np.mean(m[s:s + N] ** 2))
    if e < 0.02:
        res.append((s / sr, 0.0, e, 0.0)); continue
    F = np.fft.rfft(fr, 2 * N)
    ac = np.fft.irfft(F * np.conj(F))[:N]
    ac /= (ac[0] + 1e-9)
    seg = ac[lagmin:lagmax]
    lags = np.arange(lagmin, lagmax)
    w = seg * (1 - 0.15 * (lags - lagmin) / (lagmax - lagmin))  # evita subarmónicos
    k = np.argmax(w); lag = lagmin + k
    res.append((s / sr, sr / lag, e, seg[k]))
res = np.array(res)
t, f, e, c = res.T
hp = butter(2, 45, btype='high', fs=sr, output='sos')
def stint(tt): return any(a <= tt <= b for a, b in STINTS)
# tramos estables
good=(f>0)&(c>0.5)
segs=[]; i=0
while i<len(res):
    if not good[i]: i+=1; continue
    j=i+1
    while j<len(res) and good[j] and abs(f[j]-f[i])/f[i]<0.035: j+=1
    dur=(j-i)*hop/sr
    if dur>=0.55 and stint(t[i]): segs.append(dict(t0=t[i],dur=dur,f0=f[i:j].mean(),rms=e[i:j].mean(),conf=c[i:j].mean(),cv=f[i:j].std()/f[i:j].mean()))
    i=j
bands=[58,82,100,120,135,155,172,200,235,258,285]  # Hz de encendido (rpm = Hz*30)
def pick(hz,mode):
    best=None
    for s in segs:
        if abs(s['f0']-hz)/hz>0.09 or s['conf']<0.72 or s['cv']>0.016: continue
        if mode=='on' and s['rms']<0.085: continue
        if mode=='off' and s['rms']>0.09: continue
        score=s['conf']*2 - s['cv']*40 + min(s['dur'],1.5)*0.5 - abs(s['f0']-hz)/hz*5 + (s['rms'] if mode=='on' else -s['rms'])*2
        if best is None or score>best[0]: best=(score,s)
    return best[1] if best else None
def refine_period(x,f0):
    lo=int(sr/(f0*1.06)); hi=int(sr/(f0*0.94))
    N=len(x); F=np.fft.rfft(x*np.hanning(N),2*N); ac=np.fft.irfft(F*np.conj(F))[:N]
    k=lo+np.argmax(ac[lo:hi+1])
    a,b,cc=ac[k-1],ac[k],ac[k+1]; d=0.5*(a-cc)/(a-2*b+cc) if (a-2*b+cc)!=0 else 0
    return k+d
def frac_delay(x,d):
    n=np.arange(len(x)); return np.interp(n-d,n,x,left=0,right=0)
manifest=[]
for hz in bands:
    for mode in ['on','off']:
        s=pick(hz,mode)
        if not s: print(f"{hz:4d} {mode}: sin tramo"); continue
        s0=int(s['t0']*sr); s1=int((s['t0']+s['dur'])*sr)
        x=sosfiltfilt(hp,m[s0:s1])
        P=refine_period(x,s['f0']); f0=sr/P
        want=0.75*sr; nper=max(8,int(want/P)); L=int(round(nper*P))
        xf=int(0.02*sr)
        if L+xf+3*int(P)>=len(x): nper=int((len(x)-xf-3*int(P))/P); L=int(round(nper*P))
        start=(len(x)-L-xf)//2
        # promedio sincrónico de 3 ciclos (baja el viento) mezclado con el original
        y0=x[start:start+L+xf]
        y=0.4*y0+0.6*(frac_delay(x,P)[start:start+L+xf]*0.5+frac_delay(x,2*P)[start:start+L+xf]*0.5)*0.5+0.6*0.5*y0
        # loop con crossfade: la cola se funde con la cabeza
        head=y[:L].copy(); w=np.linspace(0,1,xf)
        head[:xf]=head[:xf]*w+y[L:L+xf]*(1-w)
        head*=0.16/np.sqrt(np.mean(head**2))
        head=np.clip(head,-0.99,0.99)
        z=resample_poly(head,32000,44100)
        name=f"eng_{int(round(f0))}_{mode}.wav"
        sf.write(f"{OUT}/{name}",z.astype(np.float32),32000,subtype='PCM_16')
        manifest.append(dict(file=name,hz=round(f0,1),throttle=mode))
        print(f"{hz:4d} {mode}: t0={s['t0']:.2f} dur={s['dur']:.2f} f0={f0:.1f} rms={s['rms']:.3f} conf={s['conf']:.2f} cv={s['cv']:.3f} -> {name} ({len(z)/32000:.2f}s)")
json.dump(manifest,open(f"{OUT}/manifest.json","w"),indent=1)
ts="/** Generado por scripts/engine_loops.py: loops del motor real por frecuencia de encendido (Hz). */\nexport const ENGINE_LOOPS: { file: string; hz: number; throttle: 'on' | 'off' }[] = [\n"
seen=set()
for e in manifest:
    if e['file'] in seen: continue
    seen.add(e['file'])
    ts+=f"  {{ file: '{e['file']}', hz: {e['hz']}, throttle: '{e['throttle']}' }},\n"
ts+="]\n"
open("src/game/engineLoops.ts","w").write(ts)
print(sum(os.path.getsize(f"{OUT}/{f}") for f in os.listdir(OUT))//1024,"KB")
