#!/usr/bin/env python3
"""从中国境内的探测点看某个地址连不连得上。用法见 deploy/README.md。

    python3 deploy/check-china.py vault.example.com xxxx.supabase.co

用的是 Globalping（https://globalping.io）这个公开的测量网络：它在中国境内有几十个探测点
（电信、联通、移动的家用宽带，和阿里云、腾讯云这些机房），不用注册。

- 主机名会发给 Globalping，测量记录凭 ID 谁都能查到。只发主机名，不带密钥和登录信息。
- 每个探测点发一次 HTTPS HEAD /。拿到任何状态码（307、404 也算）就是连上了：
  域名解析、TCP、TLS 都过了。只说明连得上，不说明大文件传得快不快。
- 先测两个对照：百度应该基本全通（八成以上），Google 应该全不通。对照不是这个结果时，
  这一轮的探测点不能代表防火墙后面的网络，下面的结果不要信（退出码是 2）。
- 所有地址用同一批探测点，可以横着比。
- 不登录时每小时大约能测 250 次（一个探测点测一个地址算一次）。
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

API = "https://api.globalping.io/v1/measurements"
CONTROL_REACHABLE = "www.baidu.com"
CONTROL_BLOCKED = "www.google.com"
POLL_SECONDS = 2
POLL_TIMES = 40


def call(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json", "user-agent": "vault-check-china/1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        sys.exit(f"Globalping 返回 HTTP {e.code}：{e.read().decode(errors='replace')[:500]}")
    except urllib.error.URLError as e:
        sys.exit(f"连不上 Globalping：{e.reason}")


def measure(host, locations):
    """返回 (测量 ID, 各探测点的结果, 是否等到了全部结果)。"""
    body = {
        "type": "http",
        "target": host,
        "locations": locations,
        "measurementOptions": {"protocol": "HTTPS", "request": {"method": "HEAD", "path": "/"}},
    }
    measurement_id = call(API, body)["id"]
    for _ in range(POLL_TIMES):
        time.sleep(POLL_SECONDS)
        measurement = call(f"{API}/{measurement_id}")
        if measurement["status"] != "in-progress":
            return measurement_id, measurement["results"], True
    return measurement_id, measurement["results"], False


def reached(result):
    return result.get("status") == "finished" and result.get("statusCode") is not None


def failure_text(result):
    lines = (result.get("rawOutput") or "").strip().splitlines()
    return lines[-1][:90] if lines else result.get("status", "")


def ms(value):
    return "-" if value is None else f"{value}ms"


def report(host, locations):
    measurement_id, results, complete = measure(host, locations)
    ok = sum(reached(r["result"]) for r in results)
    print(f"== {host}  通 {ok}/{len(results)}  （测量 {measurement_id}）")
    if not complete:
        print("  等了 80 秒还有探测点没回来，下面标「in-progress」的是没等到的，不是连不上。")
    for r in results:
        probe, result = r["probe"], r["result"]
        timings = result.get("timings") or {}
        good = reached(result)
        print(
            f"  {'通  ' if good else '不通'} {probe['city'][:10]:10} {probe['network'][:34]:34} "
            f"ip={result.get('resolvedAddress') or '-':15} 状态码={result.get('statusCode') or '-'} "
            f"tcp={ms(timings.get('tcp'))} 总共={ms(timings.get('total'))} {'' if good else failure_text(result)}"
        )
    return measurement_id, ok, len(results)


def main():
    parser = argparse.ArgumentParser(description="从中国境内的探测点看某个地址连不连得上（经 Globalping）。")
    parser.add_argument("hosts", nargs="+", metavar="主机名", help="要测的主机名，不带 https://")
    parser.add_argument("--home", type=int, default=10, help="家用宽带的探测点个数（默认 10）")
    parser.add_argument("--datacenter", type=int, default=5, help="机房的探测点个数（默认 5）")
    args = parser.parse_args()

    for host in args.hosts:
        if "/" in host:
            sys.exit(f"只要主机名，不带 https:// 和路径：{host}")

    locations = []
    if args.home > 0:
        locations.append({"country": "CN", "tags": ["eyeball-network"], "limit": args.home})
    if args.datacenter > 0:
        locations.append({"country": "CN", "tags": ["datacenter-network"], "limit": args.datacenter})
    if not locations:
        sys.exit("--home 和 --datacenter 不能都是 0")

    # 第一次测量选定探测点；之后把它的 ID 当作 locations 传回去，就是复用同一批。
    probes, ok, total = report(CONTROL_REACHABLE, locations)
    if total == 0:
        sys.exit("这一轮没有选到中国境内的探测点，过一会儿再试。")
    # 个别探测点自己掉线是常事：百度八成以上通就算对照成立；Google 通了一个都不算。
    control_ok = ok * 5 >= total * 4
    _, ok, total = report(CONTROL_BLOCKED, probes)
    control_ok = control_ok and ok == 0
    if not control_ok:
        print(f"\n!! 对照不对（{CONTROL_REACHABLE} 应该基本全通、{CONTROL_BLOCKED} 应该全不通）：这批探测点不能代表防火墙后面的网络，下面的结果不要信。\n")

    for host in args.hosts:
        report(host, probes)
    sys.exit(0 if control_ok else 2)


main()
