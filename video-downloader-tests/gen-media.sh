#!/bin/bash
# 테스트용 영상(60초)과 여러 형식의 HLS 재생목록을 만든다. ffmpeg, openssl 필요.
set -e
cd "$(dirname "$0")"
mkdir -p m && cd m
ffmpeg -loglevel error -y -f lavfi -i "testsrc=duration=60:size=320x180:rate=25" -f lavfi -i "sine=f=440:d=60" \
  -c:v libx264 -preset ultrafast -g 50 -c:a aac -shortest src.mp4
mkdir -p ts fmp4 br aes alt
ffmpeg -loglevel error -y -i src.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod ts/index.m3u8
ffmpeg -loglevel error -y -i src.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 fmp4/index.m3u8
ffmpeg -loglevel error -y -i src.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_flags single_file br/index.m3u8
openssl rand 16 > aes/k.key
printf "k.key\naes/k.key\n" > aes/ki.txt
ffmpeg -loglevel error -y -i src.mp4 -c copy -f hls -hls_time 2 -hls_playlist_type vod -hls_key_info_file aes/ki.txt aes/index.m3u8
ffmpeg -loglevel error -y -i src.mp4 -map 0:v -map 0:a -c copy -f hls -hls_time 2 -hls_playlist_type vod \
  -master_pl_name master.m3u8 -var_stream_map "v:0,agroup:aud a:0,agroup:aud,default:yes" alt/s%v.m3u8
echo "테스트 영상 준비 완료: $(pwd)"
