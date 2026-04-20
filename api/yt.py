import os
import time
import yt_dlp

def get_youtube_audio(url: str, output_dir: str) -> dict:
    """
    Extracts the best audio format from a YouTube URL and downloads it.
    Returns a dict with 'filepath' and 'title'.
    Does not use ffmpeg post-processing to avoid system dependencies; 
    relies on native m4a/webm formats.
    """
    # Create output dir if needed
    os.makedirs(output_dir, exist_ok=True)
    
    file_id = f'backing_{int(time.time()*1000)}'
    
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(output_dir, f'{file_id}.%(ext)s'),
        'quiet': True,
        'no_warnings': True,
        'extract_flat': False,
        'nocheckcertificate': True,
        'extractor_args': {
            'youtube': {
                'player_client': ['ios'],
                'player_skip': ['webpage', 'configs', 'js']
            }
        },
        'user_agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1'
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info_dict = ydl.extract_info(url, download=True)
            title = info_dict.get('title', 'YouTube Audio')
            ext = info_dict.get('ext', 'm4a')
            
            filepath = os.path.join(output_dir, f"{file_id}.{ext}")
            
            if os.path.exists(filepath):
                return {"filepath": filepath, "title": title}
            else:
                raise Exception("File downloaded but path mismatch")
    except Exception as e:
        print(f"[YT-DLP Error] {e}")
        raise e
