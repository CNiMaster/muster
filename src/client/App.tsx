import type React from "react";
import { Outlet, NavLink } from 'react-router-dom';

export function App(): React.ReactElement {  // eslint-disable-line
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">Muster · Agent 公司工作台</div>
        <nav className="topnav">
          <NavLink to="/" end>
            首页
          </NavLink>
        </nav>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
