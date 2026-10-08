#!/usr/bin/env python3
"""Analyze complete browser E2E witnesses; no production data or app mutations."""
import argparse
import base64
import csv
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path


def percentile(values, q=0.95):
    v = sorted(x for x in values if x is not None and math.isfinite(x))
    return round(v[min(len(v)-1, math.ceil(len(v)*q)-1)], 3) if v else None


def read_attachment(a):
    return json.loads(Path(a['path']).read_text() if 'path' in a else base64.b64decode(a['body']))


def witnesses(report):
    for s in report.get('suites', []):
        for spec in s.get('specs', []):
            for t in spec['tests']:
                for result in t['results']:
                    for a in result.get('attachments', []):
                        if a['name'] == 'matrix-witness.json':
                            yield read_attachment(a)
        yield from witnesses(s)


def summarize(row):
    speeds, input_gaps, schedule_late, dispatch_gaps = [], [], [], []
    validity = []
    latency, event_delay, frame_dt, steps, speeds_out, accel, early, idle, landing, settling, draw_cpu, probe_cpu = ([] for _ in range(12))
    lost = []
    handler_latency, fresh_raf_latency, pin_error = [], [], []
    for g in row['gestures']:
        ev = [v for v in row['inputs'] if v['gesture'] == g['id']]
        model = [v for v in row['models'] if v['gesture'] == g['id']]
        drawn = [v for v in row['draws'] if v['session'] == g['id']]
        moving = [v for v in drawn if v['phase'] == 'dragging']
        released = [v for v in drawn if v['phase'] == 'settling']
        duration = (ev[-1]['time']-ev[0]['time'])/1000 if len(ev)>1 else 0
        actual_speed = sum(abs(v['x']) for v in ev)/g['travel']/duration if duration else None
        gaps = [b['time']-a['time'] for a,b in zip(ev,ev[1:])]
        valid = actual_speed is not None and abs(actual_speed/g['rate']-1)<=0.25 and max(gaps,default=math.inf)<100
        # The explicit reversal pause counts in the mean speed, within tolerance.
        validity.append(valid)
        if actual_speed is not None: speeds.append(actual_speed)
        input_gaps.extend(gaps)
        schedule_late.extend(v['dispatchMs']-v['plannedMs'] for v in g['dispatch'])
        dispatch_gaps.extend(b['dispatchMs']-a['dispatchMs'] for a,b in zip(g['dispatch'],g['dispatch'][1:]))
        event_delay.extend(v['time']-v['eventTime'] for v in ev if 0<=v['time']-v['eventTime']<1000)
        if ev and not model: lost.append(g['id'])
        for d in moving:
            preceding = [v for v in ev if v['time']<=d['time']]
            if preceding:
                latency.append(d['time']-preceding[-1]['eventTime'])
                handler_latency.append(d['time']-preceding[-1]['time'])
        seen_fresh=set()
        for f in row['rafs']:
            if f['session']!=g['id'] or f['phase']!='dragging' or not f['pin'] or f['model'] is None: continue
            observed=(g['baseX']-f['pin']['x'])/(g['direction']*g['turnDistance'])
            error=abs(observed-f['model']); pin_error.append(error)
            preceding=[v for v in ev if v['time']<=f['time']]
            if error<0.001 and preceding and preceding[-1]['eventTime'] not in seen_fresh:
                seen_fresh.add(preceding[-1]['eventTime'])
                fresh_raf_latency.append(f['time']-preceding[-1]['eventTime'])
        # Resumed provisional coasts are separate motion segments. Never
        # compare two settling frames across intervening user-driven movement.
        runs=[]
        previous=None
        for d in drawn:
            if d['phase']=='settling':
                if previous is None or previous['phase']!='settling':
                    runs.append({'frames':[], 'source':previous['progress'] if previous else None})
                runs[-1]['frames'].append(d)
            previous=d
        if ev and runs:
            final=runs[-1]['frames']
            if final[0]['time']>=ev[-1]['time']:
                idle.append(final[0]['time']-ev[-1]['time'])
            landing.append(final[-1]['time']-ev[-1]['time'])
            settling.append(final[-1]['time']-final[0]['time'])
        for run in runs:
            released=run['frames']; source=run['source']
            if source is not None:
                steps.append(abs(released[0]['progress']-source))
                point=min(released,key=lambda v:abs(v['time']-released[0]['time']-33))
                early.append(abs(point['progress']-source))
            velocities=[]
            for a,b in zip(released,released[1:]):
                dt=b['time']-a['time']; dp=abs(b['progress']-a['progress'])
                if dt<=0: continue
                frame_dt.append(dt); steps.append(dp); speeds_out.append(dp/dt*1000)
                velocities.append((b['time'],dp/dt*1000))
            for a,b in zip(velocities,velocities[1:]):
                dt=b[0]-a[0]
                if dt>0: accel.append(abs(b[1]-a[1])/dt*1000)
        draw_cpu.extend(v.get('submitCpuMs',0) for v in drawn)
    probe_cpu.extend(v.get('probeCpuMs',0) for v in row['rafs'])
    actual = [c['index'] for c in row['commits']]
    return {
        'id':row['id'], 'version':row['version'], 'layout':row['layout'], 'speed':row['speed'],
        'scenario':row['scenario'], 'gap_ms':row['gap'], 'repeat':row['repetition'],
        'valid':all(validity), 'valid_gestures':sum(validity), 'gestures':len(validity),
        'planned_rate':row['rate'], 'actual_rates':','.join(f'{r:.3f}' for r in speeds),
        'max_input_gap_ms':round(max(input_gaps,default=0),3), 'schedule_late_p95_ms':percentile(schedule_late), 'schedule_late_max_ms':percentile(schedule_late,1), 'dispatch_gap_max_ms':percentile(dispatch_gaps,1),
        'wheel_processing_p95_ms':percentile(event_delay), 'input_to_draw_p95_ms':percentile(latency), 'handler_to_draw_p95_ms':percentile(handler_latency),
        'event_to_fresh_raf_p95_ms':percentile(fresh_raf_latency), 'model_pin_error_p95':percentile(pin_error), 'model_pin_error_max':percentile(pin_error,1),
        'settle_frame_p95_ms':percentile(frame_dt), 'settle_frame_max_ms':percentile(frame_dt,1),
        'settle_step_max':percentile(steps,1), 'settle_speed_max':percentile(speeds_out,1),
        'settle_acceleration_max':percentile(accel,1), 'early33_travel_max':percentile(early,1),
        'idle_to_auto_min_ms':min(idle) if idle else None, 'idle_to_auto_max_ms':max(idle) if idle else None,
        'input_to_end_max_ms':max(landing) if landing else None, 'settle_span_max_ms':max(settling) if settling else None,
        'expected_commits':json.dumps(row['expectedCommits']), 'actual_commits':json.dumps(actual),
        'expected_count':len(row['expectedCommits']), 'actual_count':len(actual), 'functional_ok':actual==row['expectedCommits'] and not lost and (row['scenario']!='cancel' or row['initial']['anchor']==row['finalAnchor']),
        'lost_gestures':json.dumps(lost), 'lost_count':len(lost),
        'cancel_anchor_ok': row['initial']['anchor']==row['finalAnchor'] if row['scenario']=='cancel' else None,
        'draw_submit_cpu_p95_ms':percentile(draw_cpu), 'raf_probe_cpu_p95_ms':percentile(probe_cpu),
        '_samples': {'latency':latency,'handlerLatency':handler_latency,'freshRafLatency':fresh_raf_latency,'pinError':pin_error,'frame_dt':frame_dt,'steps':steps,'speed':speeds_out,'early':early,'idle':idle,'landing':landing},
    }


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('evidence',type=Path)
    args=parser.parse_args(); out=args.evidence
    report_path=out/'matrix/results.json'
    report=json.loads(report_path.read_text()) if report_path.exists() else {'stats':{'pending':True}}
    raw=list(witnesses(report))
    complete={(w['version'],w['layout']) for w in raw}
    for envfile in (out/'matrix/results').glob('*/environment.json'):
        saved=[json.loads(p.read_text()) for p in envfile.parent.glob('*.json') if p.name!='environment.json']
        saved=[r for r in saved if isinstance(r,dict) and 'expectedCommits' in r]
        if saved and (saved[0]['version'],saved[0]['layout']) not in complete:
            raw.append({'version':saved[0]['version'],'layout':saved[0]['layout'],'environment':json.loads(envfile.read_text()),'rows':saved,'partial':len(saved)<28})
    if not raw: raise SystemExit('No completed samples yet')
    rows=[summarize(row) for w in raw for row in w['rows']]
    (out/'raw').mkdir(exist_ok=True)
    for w in raw: (out/'raw'/f"{w['version']}-{w['layout']}.json").write_text(json.dumps(w,ensure_ascii=False))
    fields=[k for k in rows[0] if not k.startswith('_')]
    with (out/'samples.csv').open('w') as f:
        writer=csv.DictWriter(f,fieldnames=fields); writer.writeheader(); writer.writerows({k:v for k,v in r.items() if k in fields} for r in rows)
    groups=defaultdict(list)
    for r in rows: groups[(r['version'],r['layout'],r['speed'],r['scenario'],r['gap_ms'])].append(r)
    summary=[]
    for (version,layout,speed,scenario,gap), rr in groups.items():
        valid=[r for r in rr if r['valid']]
        samples=defaultdict(list)
        for r in valid:
            for k,v in r['_samples'].items(): samples[k].extend(v)
        summary.append({'version':version,'layout':layout,'speed':speed,'scenario':scenario,'gap_ms':gap,
            'samples':len(rr),'valid_samples':len(valid),'failures':sum(not r['functional_ok'] for r in valid),
            'lost_gestures':sum(r['lost_count'] for r in valid),
            'input_to_draw_p95_ms':percentile(samples['latency']), 'handler_to_draw_p95_ms':percentile(samples['handlerLatency']), 'event_to_fresh_raf_p95_ms':percentile(samples['freshRafLatency']), 'model_pin_error_p95':percentile(samples['pinError']), 'settle_frame_p95_ms':percentile(samples['frame_dt']),
            'settle_step_max':percentile(samples['steps'],1), 'settle_speed_max':percentile(samples['speed'],1),
            'early33_travel_p50':percentile(samples['early'],.5), 'idle_p50_ms':percentile(samples['idle'],.5),
            'landing_p50_ms':percentile(samples['landing'],.5)})
    output={'stats':report['stats'],'environments':[w['environment']|{'version':w['version'],'layout':w['layout']} for w in raw],
        'total_samples':len(rows),'valid_samples':sum(r['valid'] for r in rows),'summary':summary,
        'samples':[{k:v for k,v in r.items() if not k.startswith('_')} for r in rows]}
    (out/'measurements.json').write_text(json.dumps(output,indent=2,ensure_ascii=False))
    print(json.dumps({'total':len(rows),'valid':sum(r['valid'] for r in rows),
      'normal_failures':sum(r['valid'] and not r['functional_ok'] and r['gap_ms']==600 for r in rows),
      'pressure_failures':sum(r['valid'] and not r['functional_ok'] and r['gap_ms']<600 for r in rows),
      'summary':summary},indent=2))
    manifest={}
    for name in ['web/reading-trackpad.js','web/pagination.js','web/page-curl-renderer.js','playwright.measure.config.js',
                 'tests/measurement/gesture-matrix.spec.js','scripts/analyze_gesture_matrix.py','docs/34-gesture-matrix-contract.md']:
        p=Path(name); manifest[name]=hashlib.sha256(p.read_bytes()).hexdigest()
    for name in ['pagination.js','reading-trackpad.js']:
        p=Path('outputs/wise-reader-trackpad-release-20261007/before')/name; manifest[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
    (out/'source-sha256.json').write_text(json.dumps(manifest,indent=2))

if __name__=='__main__': main()
