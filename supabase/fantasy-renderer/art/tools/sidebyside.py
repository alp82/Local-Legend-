# Target | live, same height, with captions. Usage: sidebyside.py target.png live.png out.png [h]
import sys
from PIL import Image, ImageDraw, ImageFont
t, l, out = sys.argv[1:4]; H = int(sys.argv[4]) if len(sys.argv) > 4 else 1600
A, B = Image.open(t).convert('RGB'), Image.open(l).convert('RGB')
A = A.resize((round(A.width * H / A.height), H), Image.LANCZOS); B = B.resize((round(B.width * H / B.height), H), Image.LANCZOS)
pad, top = 16, 54
C = Image.new('RGB', (A.width + B.width + pad * 3, H + top + pad), (24, 22, 20))
C.paste(A, (pad, top)); C.paste(B, (A.width + pad * 2, top))
d = ImageDraw.Draw(C)
try: f = ImageFont.truetype('DejaVuSans-Bold.ttf', 26)
except Exception: f = ImageFont.load_default()
d.text((pad, 14), 'Target (concept)', fill=(240, 220, 170), font=f); d.text((A.width + pad * 2, 14), 'Live prototype', fill=(240, 220, 170), font=f)
C.save(out)
