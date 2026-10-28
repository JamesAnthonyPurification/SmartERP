import { FormEvent, useState } from 'react';
import { useAuth } from '../auth';
import { Button, ErrorBox, Field } from '../components/ui';

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenant, setTenant] = useState('');
  const [showTenant, setShowTenant] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password, tenant.trim().toLowerCase() || undefined);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <section className="login-hero">
        <div className="row">
          <div className="brand-logo" style={{ background: '#fff', color: 'var(--red)' }}>⚡</div>
          <div className="brand-name" style={{ fontSize: 24 }}>SMARTERP</div>
        </div>
        <div>
          <h1>Run your whole business from one screen.</h1>
          <p style={{ fontSize: 18, opacity: 0.9, maxWidth: 520 }}>
            POS, inventory, production, accounts, HR and payroll for small and medium enterprises — every business
            fully isolated in its own secure workspace.
          </p>
        </div>
        <div className="small" style={{ opacity: 0.8 }}>A Multi-Tenant POS &amp; Enterprise Resource Planning System for SMEs</div>
      </section>
      <section className="login-form-wrap">
        <form className="card card-pad login-card stack" onSubmit={submit}>
          <div>
            <h2 className="page-title">Sign in</h2>
            <div className="muted">Use the account your business administrator created for you.</div>
          </div>
          <ErrorBox error={error} />
          <Field label="Email">
            <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </Field>
          <Field label="Password">
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {showTenant ? (
            <Field label="Business ID (optional)" hint="Only needed if you work for more than one business, e.g. amar-food">
              <input className="input" value={tenant} onChange={(e) => setTenant(e.target.value)} />
            </Field>
          ) : (
            <button type="button" className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowTenant(true)}>
              I work for more than one business
            </button>
          )}
          <Button variant="primary" size="lg" type="submit" loading={busy} block>Sign in</Button>
        </form>
      </section>
    </div>
  );
}
