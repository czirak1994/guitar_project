import ssl
import urllib.request
import re

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

url = "https://guitarproject-production.up.railway.app/"
try:
    req = urllib.request.Request(url)
    html = urllib.request.urlopen(req, context=ctx).read().decode('utf-8')
    match = re.search(r'src="(/assets/index-[^"]+\.js)"', html)
    if match:
        js_url = "https://guitarproject-production.up.railway.app" + match.group(1)
        js = urllib.request.urlopen(urllib.request.Request(js_url), context=ctx).read().decode('utf-8')
        if "Missing Publishable Key" in js:
            print("YES: The blank page is caused by missing VITE_CLERK_PUBLISHABLE_KEY at build time.")
        else:
            print("NO: Publishable key is present.")
    else:
        print("Could not find JS bundle.")
except Exception as e:
    print(f"Error fetching URL: {e}")
