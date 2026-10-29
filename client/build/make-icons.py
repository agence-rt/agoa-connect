"""Génère les icônes de CONNECT : carré rouge de l'agence, code « CO » en blanc et en gras, rien d'autre.

    python3 build/make-icons.py                # rouge et lettres par défaut
    python3 build/make-icons.py "#B3121A" CO   # autre rouge, autres lettres

Écrit build/icon.ico (Windows, 16 à 256 px), build/icon.png (1024 px, Mac/Linux/fenêtre)
et renderer/icon.png (64 px, en-tête de l'interface). Nécessite Pillow.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

RED = sys.argv[1] if len(sys.argv) > 1 else '#C0272D'     # rouge provisoire : à remplacer par le rouge exact de l'agence
CODE = sys.argv[2] if len(sys.argv) > 2 else 'CO'
HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = ['C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
         '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf']

def font(size):
    for f in FONTS:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    raise SystemExit('Aucune police grasse trouvée : indiquez-en une dans FONTS.')

def render(n=1024):
    im = Image.new('RGBA', (n, n), RED)
    d = ImageDraw.Draw(im)
    size = int(n * 0.56)
    f = font(size)
    l, t, r, b = d.textbbox((0, 0), CODE, font=f)
    while (r - l) > n * 0.68:                                # les lettres tiennent toujours dans le carré
        size -= 8; f = font(size); l, t, r, b = d.textbbox((0, 0), CODE, font=f)
    d.text(((n - (r - l)) / 2 - l, (n - (b - t)) / 2 - t), CODE, font=f, fill='white')   # centré sur l'encre, pas sur la ligne
    return im

big = render(1024)
big.save(os.path.join(HERE, 'icon.png'))
big.resize((64, 64), Image.LANCZOS).save(os.path.join(HERE, '..', 'renderer', 'icon.png'))
big.save(os.path.join(HERE, 'icon.ico'), sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
print('Icônes écrites : icon.ico, icon.png, renderer/icon.png (%s, « %s »)' % (RED, CODE))
