import time
import sys
import cProfile
import pstats
import io
from pathlib import Path

def run_profile():
    # 1. Measure Import Time
    start_time = time.perf_counter()
    import opm.core as core
    from opm.core import PresetManager
    import opm.cli as cli
    try:
        import opm.tui as tui
    except ImportError:
        tui = None
    import rich
    import questionary
    import textual
    import urllib.request
    import json
    import base64
    import datetime
    import shutil
    import typing
    import pstats
    import io
    import cProfile
    end_time = time.perf_counter()
    print(f"Total Import Time: {end_time - start_time:.4f}s")

    manager = PresetManager()
    
    # Wrap sub-functions to track calls and timing
    original_openai = core._fetch_openai_quota_for_token
    original_google = core._fetch_google_quota_for_token
    
    call_stats = {
        "openai_calls": 0,
        "openai_time": 0.0,
        "google_calls": 0,
        "google_time": 0.0
    }

    def wrapped_openai(*args, **kwargs):
        call_stats["openai_calls"] += 1
        s = time.perf_counter()
        res = original_openai(*args, **kwargs)
        e = time.perf_counter()
        call_stats["openai_time"] += (e - s)
        print(f"  [OpenAI API] Request took {e - s:.4f}s")
        return res

    def wrapped_google(*args, **kwargs):
        call_stats["google_calls"] += 1
        s = time.perf_counter()
        res = original_google(*args, **kwargs)
        e = time.perf_counter()
        call_stats["google_time"] += (e - s)
        print(f"  [Google API] Request took {e - s:.4f}s")
        return res

    core._fetch_openai_quota_for_token = wrapped_openai
    core._fetch_google_quota_for_token = wrapped_google

    # 2. Profile collect_all_quota
    print("\nProfiling collect_all_quota()...")
    pr = cProfile.Profile()
    pr.enable()
    
    start_all = time.perf_counter()
    
    print("Executing collect_active_quota()...")
    s_active = time.perf_counter()
    active_results = manager.collect_active_quota()
    e_active = time.perf_counter()
    print(f"collect_active_quota() total: {e_active - s_active:.4f}s")
    
    print("Executing collect_openai_quota()...")
    s_openai = time.perf_counter()
    openai_results = manager.collect_openai_quota()
    e_openai = time.perf_counter()
    print(f"collect_openai_quota() total: {e_openai - s_openai:.4f}s")
    
    end_all = time.perf_counter()
    pr.disable()
    
    print(f"\ncollect_all_quota() total wall time: {end_all - start_all:.4f}s")
    print(f"Total API Calls: OpenAI={call_stats['openai_calls']}, Google={call_stats['google_calls']}")
    print(f"Total API Time: OpenAI={call_stats['openai_time']:.4f}s, Google={call_stats['google_time']:.4f}s")
    
    # 3. Analyze cProfile results
    s = io.StringIO()
    sortby = pstats.SortKey.CUMULATIVE
    ps = pstats.Stats(pr, stream=s).sort_stats(sortby)
    ps.print_stats(20)  # Top 20
    print("\nTop 20 functions by cumulative time:")
    print(s.getvalue())

    # Check for parallelization hint
    if call_stats['openai_calls'] + call_stats['google_calls'] > 1:
        # If API time is roughly equal to total time, it's sequential
        api_total = call_stats['openai_time'] + call_stats['google_time']
        wall_total = end_all - start_all
        if wall_total >= api_total * 0.9:
            print("\nCONCLUSION: Network requests appear to be SEQUENTIAL.")
        else:
            print("\nCONCLUSION: Network requests appear to be PARALLELIZED.")
    else:
        print("\nNot enough API calls to determine parallelization.")

if __name__ == "__main__":
    run_profile()
