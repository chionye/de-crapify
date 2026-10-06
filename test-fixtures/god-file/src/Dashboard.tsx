import { useEffect, useMemo, useState } from 'react';
import { clamp, pluralize } from './utils';

// Types for the dashboard
export interface Stat {
  id: string;
  label: string;
  value: number;
  previous: number;
  currency?: boolean;
}

export interface ActivityItem {
  id: string;
  user: string;
  action: 'created' | 'updated' | 'deleted' | 'commented';
  target: string;
  at: Date;
}

export interface Settings {
  displayName: string;
  email: string;
  timezone: string;
  weeklyDigest: boolean;
  theme: 'light' | 'dark' | 'system';
}

// Shared card style used by every panel
const cardStyle = {
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: 16,
  background: '#ffffff',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
};

// Format a number as currency
function formatCurrency(value: number): string {
  // Create the formatter
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
  // Return the formatted value
  return formatter.format(value);
}

// Format a date as "x minutes ago"
function timeAgo(date: Date, now: Date = new Date()): string {
  // Get the difference in seconds
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  // Check if it was just now
  if (seconds < 60) {
    return 'just now';
  }
  // Get the minutes
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} ${pluralize('minute', minutes)} ago`;
  }
  // Get the hours
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${pluralize('hour', hours)} ago`;
  }
  // Get the days
  const days = Math.floor(hours / 24);
  return `${days} ${pluralize('day', days)} ago`;
}

// StatsPanel shows the key numbers with their change since last period
export function StatsPanel({ stats, loading }: { stats: Stat[]; loading: boolean }) {
  // State for the selected stat
  const [selected, setSelected] = useState<string | null>(null);
  // State for whether to show percentages
  const [showPercent, setShowPercent] = useState(true);

  // Compute the changes for each stat
  const changes = useMemo(() => {
    // Map over the stats
    return stats.map((stat) => {
      // Get the difference
      const diff = stat.value - stat.previous;
      // Get the percentage
      const percent = stat.previous === 0 ? 0 : (diff / stat.previous) * 100;
      // Return the change
      return { id: stat.id, diff, percent };
    });
  }, [stats]);

  // Check if loading
  if (loading) {
    return (
      <section style={cardStyle}>
        <p>Loading stats…</p>
      </section>
    );
  }

  // Check if there are no stats
  if (stats.length === 0) {
    return (
      <section style={cardStyle}>
        <p>No stats yet.</p>
      </section>
    );
  }

  return (
    <section style={cardStyle}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h2>Overview</h2>
        <label>
          <input type="checkbox" checked={showPercent} onChange={(e) => setShowPercent(e.target.checked)} />
          Show %
        </label>
      </header>
      <ul style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, listStyle: 'none', padding: 0 }}>
        {stats.map((stat, index) => {
          const change = changes[index];
          const isUp = change.diff >= 0;
          return (
            <li
              key={stat.id}
              onClick={() => setSelected(stat.id === selected ? null : stat.id)}
              style={{
                padding: 12,
                borderRadius: 8,
                background: stat.id === selected ? '#eef2ff' : 'transparent',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontSize: 12, color: '#6b7280' }}>{stat.label}</div>
              <div style={{ fontSize: 24, fontWeight: 600 }}>
                {stat.currency ? formatCurrency(stat.value) : stat.value.toLocaleString()}
              </div>
              <div style={{ color: isUp ? '#059669' : '#dc2626' }}>
                {isUp ? '▲' : '▼'}{' '}
                {showPercent
                  ? `${clamp(Math.abs(change.percent), 0, 999).toFixed(1)}%`
                  : stat.currency
                    ? formatCurrency(Math.abs(change.diff))
                    : Math.abs(change.diff).toLocaleString()}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ActivityFeed shows the most recent activity
export function ActivityFeed({ items, limit = 10 }: { items: ActivityItem[]; limit?: number }) {
  // State for the filter
  const [filter, setFilter] = useState<ActivityItem['action'] | 'all'>('all');
  // State for the current time, so "x minutes ago" stays fresh
  const [now, setNow] = useState(() => new Date());
  // State for whether to show all items
  const [expanded, setExpanded] = useState(false);

  // Update the current time every minute
  useEffect(() => {
    // Create the interval
    const id = setInterval(() => setNow(new Date()), 60_000);
    // Clear the interval on unmount
    return () => clearInterval(id);
  }, []);

  // Filter the items
  const filtered = useMemo(() => {
    // Check if the filter is all
    if (filter === 'all') {
      return items;
    }
    // Return the filtered items
    return items.filter((item) => item.action === filter);
  }, [items, filter]);

  // Get the visible items
  const visible = expanded ? filtered : filtered.slice(0, limit);

  // Get the icon for an action
  const iconFor = (action: ActivityItem['action']) => {
    if (action === 'created') {
      return '＋';
    } else if (action === 'updated') {
      return '✎';
    } else if (action === 'deleted') {
      return '✕';
    } else {
      return '💬';
    }
  };

  return (
    <section style={cardStyle}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Activity</h2>
        <select value={filter} onChange={(e) => setFilter(e.target.value as ActivityItem['action'] | 'all')}>
          <option value="all">All</option>
          <option value="created">Created</option>
          <option value="updated">Updated</option>
          <option value="deleted">Deleted</option>
          <option value="commented">Comments</option>
        </select>
      </header>
      {visible.length === 0 ? (
        <p style={{ color: '#6b7280' }}>Nothing here yet.</p>
      ) : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {visible.map((item) => (
            <li key={item.id} style={{ display: 'flex', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
              <span aria-hidden="true">{iconFor(item.action)}</span>
              <span style={{ flex: 1 }}>
                <strong>{item.user}</strong> {item.action} <em>{item.target}</em>
              </span>
              <time dateTime={item.at.toISOString()} style={{ color: '#9ca3af', fontSize: 12 }}>
                {timeAgo(item.at, now)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {filtered.length > limit && (
        <button type="button" onClick={() => setExpanded(!expanded)} style={{ marginTop: 8 }}>
          {expanded ? 'Show less' : `Show all ${filtered.length}`}
        </button>
      )}
    </section>
  );
}

// SettingsForm lets the user edit their settings
export function SettingsForm({ initial, onSave }: { initial: Settings; onSave: (settings: Settings) => Promise<void> }) {
  // State for the form values
  const [values, setValues] = useState<Settings>(initial);
  // State for saving
  const [saving, setSaving] = useState(false);
  // State for the error
  const [error, setError] = useState<string | null>(null);
  // State for the success message
  const [saved, setSaved] = useState(false);

  // Reset the form when the initial values change
  useEffect(() => {
    setValues(initial);
  }, [initial]);

  // Update a single field
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    // Set the values
    setValues((prev) => ({ ...prev, [key]: value }));
    // Clear the saved message
    setSaved(false);
  };

  // Handle the form submission
  const handleSubmit = async (event: { preventDefault(): void }) => {
    // Prevent the default
    event.preventDefault();
    // Check the display name
    if (values.displayName.trim() === '') {
      setError('Display name is required');
      return;
    }
    // Check the email
    if (!values.email.includes('@')) {
      setError('Email is invalid');
      return;
    }
    // Clear the error
    setError(null);
    // Set saving
    setSaving(true);
    try {
      // Save the settings
      await onSave(values);
      // Set saved
      setSaved(true);
    } catch (e) {
      // Set the error
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      // Clear saving
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={cardStyle}>
      <h2>Settings</h2>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Display name
        <input value={values.displayName} onChange={(e) => update('displayName', e.target.value)} />
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Email
        <input type="email" value={values.email} onChange={(e) => update('email', e.target.value)} />
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Timezone
        <select value={values.timezone} onChange={(e) => update('timezone', e.target.value)}>
          <option value="UTC">UTC</option>
          <option value="Europe/Berlin">Europe/Berlin</option>
          <option value="America/New_York">America/New York</option>
          <option value="Asia/Tokyo">Asia/Tokyo</option>
        </select>
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        <input type="checkbox" checked={values.weeklyDigest} onChange={(e) => update('weeklyDigest', e.target.checked)} />
        Send me a weekly digest
      </label>
      <fieldset style={{ border: 'none', padding: 0, marginBottom: 8 }}>
        <legend>Theme</legend>
        {(['light', 'dark', 'system'] as const).map((theme) => (
          <label key={theme} style={{ marginRight: 12 }}>
            <input type="radio" name="theme" checked={values.theme === theme} onChange={() => update('theme', theme)} />
            {theme}
          </label>
        ))}
      </fieldset>
      {error && <p style={{ color: '#dc2626' }}>{error}</p>}
      {saved && <p style={{ color: '#059669' }}>Saved!</p>}
      <button type="submit" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

// Dashboard page that puts everything together
export default function Dashboard({ userId }: { userId: string }) {
  // State for the stats
  const [stats, setStats] = useState<Stat[]>([]);
  // State for the activity
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  // State for the settings
  const [settings, setSettings] = useState<Settings | null>(null);
  // State for loading
  const [loading, setLoading] = useState(true);
  // State for the active tab
  const [tab, setTab] = useState<'overview' | 'settings'>('overview');

  // Load the data when the user changes
  useEffect(() => {
    // Track if the component is still mounted
    let cancelled = false;
    // Set loading
    setLoading(true);
    // Fetch everything in parallel
    Promise.all([
      fetch(`/api/users/${userId}/stats`).then((r) => r.json()),
      fetch(`/api/users/${userId}/activity`).then((r) => r.json()),
      fetch(`/api/users/${userId}/settings`).then((r) => r.json()),
    ])
      .then(([statsData, activityData, settingsData]) => {
        // Check if cancelled
        if (cancelled) {
          return;
        }
        // Set the stats
        setStats(statsData);
        // Set the activity, converting dates
        setActivity(activityData.map((item: ActivityItem) => ({ ...item, at: new Date(item.at) })));
        // Set the settings
        setSettings(settingsData);
      })
      .finally(() => {
        // Clear loading
        if (!cancelled) {
          setLoading(false);
        }
      });
    // Cleanup
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Save the settings
  const saveSettings = async (next: Settings) => {
    // Send the request
    const response = await fetch(`/api/users/${userId}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    });
    // Check the response
    if (!response.ok) {
      throw new Error('Could not save settings');
    }
    // Update the settings
    setSettings(next);
  };

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: 24, display: 'grid', gap: 16 }}>
      <nav style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => setTab('overview')} disabled={tab === 'overview'}>
          Overview
        </button>
        <button type="button" onClick={() => setTab('settings')} disabled={tab === 'settings'}>
          Settings
        </button>
      </nav>
      {tab === 'overview' ? (
        <>
          <StatsPanel stats={stats} loading={loading} />
          <ActivityFeed items={activity} />
        </>
      ) : settings ? (
        <SettingsForm initial={settings} onSave={saveSettings} />
      ) : (
        <section style={cardStyle}>
          <p>Loading settings…</p>
        </section>
      )}
    </main>
  );
}
