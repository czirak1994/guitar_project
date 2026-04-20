import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area
} from 'recharts';

export default function PerformanceChart({ sessions }) {
  if (!sessions || sessions.length < 2) {
    return (
      <div className="empty-state" style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-panel)', borderRadius: 'var(--radius-sm)', border: '1px dashed var(--border)' }}>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-3)' }}>Complete at least 2 sessions to see trend data.</p>
      </div>
    );
  }

  // Format data for Recharts: last 15 sessions
  const data = sessions.map((s, idx) => ({
    name: idx + 1,
    accuracy: s.accuracy_pct || 0,
    timing: Math.abs(s.timing_error_ms || 0)
  })).slice(-15);

  return (
    <div className="widget" style={{ padding: '16px', marginBottom: '24px', background: 'var(--bg-panel-hi)', border: '1px solid var(--border-hi)' }}>
      <div className="widget-title" style={{ marginBottom: '16px' }}>Performance Trends (Last 15 Sessions)</div>
      
      <div style={{ width: '100%', height: 180 }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 5, right: 20, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
            <XAxis dataKey="name" hide />
            <YAxis domain={[0, 100]} hide />
            <Tooltip 
              contentStyle={{ background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '0.75rem' }}
              itemStyle={{ padding: '2px 0' }}
            />
            <Line 
              type="monotone" 
              dataKey="accuracy" 
              stroke="var(--accent)" 
              strokeWidth={3} 
              dot={{ r: 4, fill: 'var(--accent)' }} 
              activeDot={{ r: 6 }} 
              name="Accuracy (%)"
            />
            <Line 
              type="monotone" 
              dataKey="timing" 
              stroke="var(--yellow)" 
              strokeWidth={2} 
              strokeDasharray="5 5"
              dot={false}
              name="Timing Err (ms)"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      
      <div style={{ display: 'flex', gap: '16px', marginTop: '12px', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.7rem', color: 'var(--text-2)' }}>
          <div style={{ width: 12, height: 3, background: 'var(--accent)' }} /> Accuracy (%)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.7rem', color: 'var(--text-2)' }}>
          <div style={{ width: 12, height: 3, background: 'var(--yellow)', borderTop: '1px dashed #fff' }} /> Timing Err (ms)
        </div>
      </div>
    </div>
  );
}
