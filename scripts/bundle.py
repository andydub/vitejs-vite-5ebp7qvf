#!/usr/bin/env python3
"""Empaqueta el build de Vite en un único HTML con modelos, audio e imágenes
embebidos en base64, listo para publicar como Artifact.

Uso:  npm run build && python3 scripts/bundle.py salida.html
"""
import base64, glob, os, sys

out = sys.argv[1] if len(sys.argv) > 1 else 'sport4-alvear.html'
js = open(glob.glob('dist/assets/*.js')[0]).read()
css = open(glob.glob('dist/assets/*.css')[0]).read()
assert '</script' not in js

b = lambda f: base64.b64encode(open(f, 'rb').read()).decode()
imgs = []
for name, mime in [('lucio.jpg', 'image/jpeg'), ('logo-alvear.png', 'image/png'), ('logo-act.png', 'image/png')]:
    f = 'public/img/' + name
    if os.path.exists(f):
        imgs.append(f'"{name}":"data:{mime};base64,{b(f)}"')
audio = ','.join(f'{k}:"data:audio/mpeg;base64,{b("public/audio/" + k + ".mp3")}"' for k in ['menu', 'relato', 'largada', 'velocidad'])
# Loops del motor real (WAV cortos), con la misma clave que usa audioSrc().
engine = sorted(glob.glob('public/audio/engine/*.wav'))
audio += ''.join(f',"engine/{os.path.basename(f)}":"data:audio/wav;base64,{b(f)}"' for f in engine)
models = ','.join(f'{k}:"{b("public/models/" + k + ".glb")}"' for k in ['car29', 'car1'])

html = f'''<title>Sport 4 Alvear</title>
<meta name="description" content="Juego de carreras 3D: Sport 4 en el Autódromo Víctor García de General Alvear">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800;900&family=Barlow:wght@400;600;700&display=swap">
<style>
{css}
</style>
<div id="root"></div>
<script>window.__SPORT4_MODELS={{{models}}};window.__SPORT4_AUDIO={{{audio}}};window.__SPORT4_IMG={{{",".join(imgs)}}}</script>
<script type="module">
{js}
</script>
'''
open(out, 'w').write(html)
print(out, len(html) // 1024, 'KB')
