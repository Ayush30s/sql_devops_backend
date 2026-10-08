import { InMemoryFs } from "just-bash";
import { LabFs } from "./fs.ts";
import type { AwsState, Device, LabState, Proc, Unit } from "./system.ts";
import { GiB, HOSTNAME, LOGIN, MEM_TOTAL_KB, MiB, SHELL_PID, isoTime, journal, rng, syslogTime } from "./system.ts";

/**
 * The base machine every lab starts from: an Ubuntu 24.04 EC2 instance running nginx in front of
 * a Node.js app ("Acme Store"), with realistic config files and logs. Logs come from a seeded
 * generator, so exercise answers (top IPs, error counts…) are the same for every learner.
 */

type Spec = [path: string, content: string, mode?: number, owner?: [string, string]];

const DIRS: [string, number?, [string, string]?][] = [
  ["/etc/nginx/sites-available"], ["/etc/nginx/sites-enabled"], ["/etc/nginx/conf.d"], ["/etc/ssh"], ["/etc/skel"],
  ["/etc/sudoers.d", 0o750], ["/etc/cron.d"], ["/etc/cron.daily"], ["/etc/logrotate.d"], ["/etc/systemd/system"],
  ["/etc/webapp", 0o750, ["root", "webapp"]],
  ["/usr/bin"], ["/usr/sbin"], ["/usr/local/bin"], ["/usr/local/sbin"], ["/usr/lib/systemd/system"], ["/usr/share/doc"],
  ["/home/student/projects"], ["/home/student/logs"], ["/home/student/scripts"], ["/home/student/practice"],
  ["/home/student/.ssh", 0o700], ["/home/student/.aws"], ["/home/ubuntu/.ssh", 0o700], ["/home/deploy/releases"],
  ["/root/.ssh", 0o700], ["/root", 0o700],
  ["/var/log/nginx", 0o755, ["root", "adm"]], ["/var/log/webapp", 0o755, ["webapp", "webapp"]], ["/var/log/journal"], ["/var/log/apt"],
  ["/var/www/html"], ["/var/lib/dpkg"], ["/var/cache"], ["/var/spool/cron/crontabs", 0o1730, ["root", "crontab"]],
  ["/var/tmp", 0o1777], ["/tmp", 0o1777], ["/opt/webapp", 0o755, ["webapp", "webapp"]],
  ["/srv/backups"], ["/data"], ["/mnt"], ["/media"], ["/boot/efi"], ["/run/user/1001", 0o700, ["student", "student"]], ["/proc"], ["/dev"],
];


const BASHRC = `# ~/.bashrc: executed by bash(1) for non-login shells.

# don't put duplicate lines or lines starting with space in the history.
HISTCONTROL=ignoreboth
HISTSIZE=1000
HISTFILESIZE=2000

# some more ls aliases
alias ll='ls -alF'
alias la='ls -A'
alias l='ls -CF'

export EDITOR=nano
`;

const PROFILE = `# ~/.profile: executed by the command interpreter for login shells.
if [ -n "$BASH_VERSION" ]; then
    if [ -f "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/bin" ] ; then
    PATH="$HOME/bin:$PATH"
fi
`;

const NGINX_CONF = `user www-data;
worker_processes auto;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log;

events {
    worker_connections 768;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;
    server_tokens off;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    access_log /var/log/nginx/access.log;
    gzip on;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`;

const NGINX_SITE = `# Acme Store: static site plus the Node.js API behind /api/
server {
    listen 80 default_server;
    listen [::]:80 default_server;

    root /var/www/html;
    index index.html;
    server_name _;

    location / {
        try_files $uri $uri/ =404;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
`;

const SERVER_JS = `// Acme Store API (simplified)
const http = require("http");
const port = Number(process.env.PORT || 3000);

http
  .createServer((req, res) => {
    if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ service: "acme-store", path: req.url }));
  })
  .listen(port, () => console.log(\`webapp listening on port \${port}\`));
`;

const INDEX_HTML = `<!doctype html>
<html>
  <head><title>Acme Store</title></head>
  <body>
    <h1>Welcome to Acme Store</h1>
    <p>Everything you need, delivered fast.</p>
  </body>
</html>
`;

const BACKUP_SH = `#!/bin/bash
# Back up the webapp configuration into /srv/backups
set -e
STAMP=$(date +%Y-%m-%d)
DEST=/srv/backups/webapp-config-$STAMP.tar.gz
tar -czf "$DEST" /etc/webapp
echo "Backup written to $DEST"
`;

function unitFile(desc: string, user: string, exec: string, extra = "") {
  return `[Unit]\nDescription=${desc}\nAfter=network.target\n\n[Service]\nUser=${user}\n${extra}ExecStart=${exec}\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n`;
}

// ---- generated logs -------------------------------------------------------------------------

const PATHS = ["/", "/products", "/products/42", "/products/7", "/products/19", "/cart", "/api/cart", "/api/products", "/api/checkout", "/login", "/static/app.js", "/static/site.css", "/favicon.ico"];
const SCANNER_PATHS = ["/wp-login.php", "/.env", "/admin.php", "/phpmyadmin/", "/.git/config"];
const AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "curl/8.5.0",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

function nginxTime(t: number) {
  const d = new Date(t);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${mon}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** 400 requests over the last day. 203.0.113.77 is the heaviest client; 45.33.12.9 is a scanner. */
function accessLog(now: number) {
  const r = rng(42);
  const regular = ["198.51.100.23", "198.51.100.41", "192.0.2.14", "192.0.2.88", "203.0.113.5", "203.0.113.19", "198.51.100.7", "192.0.2.150"];
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) {
    const t = now - 24 * 3600_000 + Math.floor((i / 400) * 23.5 * 3600_000) + r.int(0, 60_000);
    const roll = r.next();
    let ip = roll < 0.18 ? "203.0.113.77" : roll < 0.24 ? "45.33.12.9" : r.pick(regular);
    let path = ip === "45.33.12.9" ? r.pick(SCANNER_PATHS) : r.pick(PATHS);
    let method = path.startsWith("/api/c") && r.next() < 0.5 ? "POST" : "GET";
    let status = ip === "45.33.12.9" ? 404 : r.next() < 0.08 ? 304 : 200;
    if (path === "/api/checkout" && r.next() < 0.35) status = 500;
    if (i >= 300 && i < 312 && path.startsWith("/api/")) status = 502;
    if (path === "/login" && method === "GET" && r.next() < 0.1) status = 301;
    if (i === 250) [ip, path, method, status] = ["198.51.100.23", "/api/checkout", "POST", 500];
    const bytes = status === 304 ? 0 : status >= 500 ? 166 : status === 404 ? 162 : r.int(512, 24000);
    lines.push(`${ip} - - [${nginxTime(t)}] "${method} ${path} HTTP/1.1" ${status} ${bytes} "-" "${ip === "45.33.12.9" ? "Mozilla/5.0 zgrab/0.x" : r.pick(AGENTS)}"`);
  }
  return lines.join("\n") + "\n";
}

const APP_ERRORS = [
  "PaymentGatewayTimeout: payment provider did not respond within 5000ms",
  "PaymentGatewayTimeout: payment provider did not respond within 5000ms",
  "DatabaseError: connection reset by peer (db.internal:5432)",
  "ValidationError: cart item quantity must be positive",
];

/** 300 lines; exactly 21 ERROR and 34 WARN lines. */
function appLog(now: number) {
  const r = rng(7);
  const lines: string[] = [];
  let errors = 0;
  let warns = 0;
  for (let i = 0; i < 300; i++) {
    const t = now - 6 * 3600_000 + i * 72_000;
    const ts = isoTime(t);
    const ms = r.int(4, 180);
    const roll = r.next();
    if ((roll < 0.07 && errors < 21) || (i > 290 && errors < 21)) {
      errors++;
      lines.push(`${ts} ERROR [checkout] ${APP_ERRORS[errors % APP_ERRORS.length]}`);
    } else if ((roll < 0.19 && warns < 34) || (i > 280 && warns < 34)) {
      warns++;
      lines.push(`${ts} WARN  [db] slow query took ${r.int(800, 2400)}ms: SELECT * FROM orders WHERE customer_id = $1`);
    } else {
      const p = r.pick(["/api/products", "/api/cart", "/api/products/42", "/api/checkout", "/health"]);
      lines.push(`${ts} INFO  [http] ${p.includes("checkout") ? "POST" : "GET"} ${p} 200 ${ms}ms`);
    }
  }
  return lines.join("\n") + "\n";
}

function authLog(now: number) {
  const r = rng(99);
  const attackers = [["45.33.12.9", 31], ["185.220.101.4", 17], ["103.77.192.11", 9], ["91.240.118.30", 4]] as const;
  const users = ["admin", "root", "test", "oracle", "postgres", "ubuntu", "git"];
  const events: [number, string][] = [];
  for (const [ip, count] of attackers)
    for (let i = 0; i < count; i++) {
      const user = r.pick(users);
      const invalid = user !== "root" && user !== "ubuntu";
      events.push([now - r.int(1, 20 * 3600) * 1000, `sshd[${r.int(2000, 2900)}]: Failed password for ${invalid ? "invalid user " : ""}${user} from ${ip} port ${r.int(30000, 65000)} ssh2`]);
    }
  events.push([now - 3 * 3600_000, "sshd[1820]: Accepted publickey for student from 203.0.113.50 port 52314 ssh2: ED25519 SHA256:k3Yq8m0aZ1pV4cX7bN2sD5fG8hJ0lQ3wE6rT9yU1iO4"]);
  events.push([now - 3 * 3600_000 + 1000, "sshd[1820]: pam_unix(sshd:session): session opened for user student(uid=1001) by (uid=0)"]);
  events.push([now - 2 * 3600_000, "sudo:  student : TTY=pts/0 ; PWD=/home/student ; USER=root ; COMMAND=/usr/bin/systemctl status nginx"]);
  events.push([now - 26 * 3600_000, "sshd[1102]: Accepted publickey for deploy from 10.0.1.50 port 40122 ssh2: ED25519 SHA256:Zx1c2V3b4N5m6A7s8D9f0G1h2J3k4L5"]);
  events.sort((a, b) => a[0] - b[0]);
  return events.map(([t, msg]) => `${syslogTime(t)} ${HOSTNAME} ${msg}`).join("\n") + "\n";
}

function syslog(now: number, boot: number) {
  const lines = [
    [boot, "kernel: [    0.000000] Linux version 6.8.0-1012-aws (buildd@lcy02-amd64-012) (x86_64-linux-gnu-gcc-13) #13-Ubuntu SMP"],
    [boot + 4000, "systemd[1]: Started ssh.service - OpenBSD Secure Shell server."],
    [boot + 4500, "systemd[1]: Started nginx.service - A high performance web server and a reverse proxy server."],
    [boot + 5000, "systemd[1]: Started webapp.service - Acme Store web application."],
    [now - 5 * 3600_000, "CRON[2210]: (root) CMD (test -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.daily; })"],
    [now - 3 * 3600_000, "systemd-logind[418]: New session 4 of user student."],
    [now - 2 * 3600_000, "kernel: [271231.402113] TCP: request_sock_TCP: Possible SYN flooding on port 80. Sending cookies.  Check SNMP counters."],
    [now - 50 * 60_000, "amazon-ssm-agent[410]: INFO [ssm-agent-worker] Successfully connected to Systems Manager"],
    [now - 20 * 60_000, "CRON[2350]: (root) CMD (command -v debian-sa1 > /dev/null && debian-sa1 1 1)"],
  ] as const;
  return lines.map(([t, m]) => `${syslogTime(t)} ${HOSTNAME} ${m}`).join("\n") + "\n";
}

// ---- practice files -------------------------------------------------------------------------

const PRACTICE: Spec[] = [
  ["/home/student/practice/fruits.txt", "banana\napple\ncherry\napple\nmango\nbanana\nkiwi\napple\n"],
  ["/home/student/practice/numbers.txt", "42\n7\n19\n3\n88\n7\n15\n"],
  ["/home/student/practice/servers.txt", "web-1 10.0.1.23 running\nweb-2 10.0.1.50 running\ndb-1 10.0.2.15 running\nbastion 10.0.0.5 stopped\nbatch-worker 10.0.3.40 stopped\n"],
  [
    "/home/student/practice/employees.csv",
    "name,department,salary,city\nRahul,Engineering,95000,Ahmedabad\nPriya,Marketing,72000,Mumbai\nAmit,Engineering,105000,Delhi\nNeha,Sales,64000,Mumbai\nVikram,Engineering,88000,Pune\nAnjali,Sales,70000,Delhi\nKaran,Support,52000,Ahmedabad\nSara,Marketing,78000,Pune\n",
  ],
  ["/home/student/practice/notes.txt", "Remember to rotate the logs.\nCheck disk space every Monday.\nTODO: renew the TLS certificate\nTODO: update the README\n"],
  ["/home/student/practice/poem.txt", "The server hums through the night,\nlogs scroll by in amber light.\nA single ERROR, then it's gone,\nthe pager sleeps until the dawn.\n"],
  ["/home/student/practice/config.json", '{\n  "service": "acme-store",\n  "port": 3000,\n  "features": ["cart", "checkout", "reviews"],\n  "database": { "host": "db.internal", "port": 5432 }\n}\n'],
  ["/home/student/projects/README.md", "# Projects\n\nYour working area. Try: ls -la, cd webapp, cat README.md\n"],
  ["/home/student/projects/webapp/README.md", "# Acme Store\n\nNode.js API served on port 3000 behind nginx.\n"],
  ["/home/student/projects/webapp/package.json", '{\n  "name": "acme-store",\n  "version": "2.4.1",\n  "scripts": { "start": "node server.js" }\n}\n'],
  ["/home/student/projects/webapp/server.js", SERVER_JS],
  ["/home/student/scripts/backup.sh", BACKUP_SH, 0o644],
  ["/home/student/scripts/hello.sh", '#!/bin/bash\necho "Hello from $(hostname)!"\n', 0o644],
  ["/home/student/README.txt", "Welcome to your practice server!\n\nThis machine is a safe simulation of an Ubuntu EC2 instance.\nNothing you do here can affect a real system.\n\nFolders:\n  projects/  your code\n  logs/      sample logs\n  scripts/   shell scripts\n  practice/  files for exercises\n"],
];

const AWS: () => AwsState = () => {
  const day = 86400_000;
  const now = Date.now();
  const inst = (id: string, name: string, type: string, state: string, ip: string, pub: string | null, env: string) => ({
    InstanceId: id,
    ImageId: "ami-0e86e20dae9224db8",
    InstanceType: type,
    KeyName: "acme-prod",
    LaunchTime: isoTime(now - 40 * day),
    Placement: { AvailabilityZone: ip.startsWith("10.0.2") ? "us-east-1b" : "us-east-1a" },
    PrivateIpAddress: ip,
    ...(pub && state === "running" ? { PublicIpAddress: pub } : {}),
    State: { Code: state === "running" ? 16 : 80, Name: state },
    SubnetId: ip.startsWith("10.0.2") ? "subnet-0b2c3d4e" : "subnet-0a1b2c3d",
    VpcId: "vpc-0a1b2c3d4e5f",
    SecurityGroups: [{ GroupName: name.startsWith("db") ? "acme-db" : "acme-web", GroupId: name.startsWith("db") ? "sg-0db0db0db" : "sg-0web0web0" }],
    Tags: [{ Key: "Name", Value: name }, { Key: "Environment", Value: env }, { Key: "Team", Value: name.startsWith("batch") ? "data" : "platform" }],
  });
  const obj = (size: number, ageDays: number, body?: string) => ({ size, mtime: now - ageDays * day, ...(body !== undefined && { body }) });
  return {
    account: "123456789012",
    role: "webapp-ec2-role",
    s3: {
      "acme-app-assets": { created: now - 400 * day, region: "us-east-1", objects: { "css/site.css": obj(4810, 12, "body{font-family:sans-serif}\n"), "js/app.js": obj(18233, 3), "images/logo.png": obj(24576, 90), "index.html": obj(512, 3, INDEX_HTML) } },
      "acme-app-backups": { created: now - 400 * day, region: "us-east-1", objects: { "db/acme-2026-09-29.sql.gz": obj(118 * MiB, 3), "db/acme-2026-09-30.sql.gz": obj(119 * MiB, 2), "db/acme-2026-10-01.sql.gz": obj(121 * MiB, 1) } },
      "acme-app-logs": { created: now - 300 * day, region: "us-east-1", objects: { "nginx/2026/10/01/access.log.gz": obj(2.1 * MiB, 1), "nginx/2026/09/30/access.log.gz": obj(1.9 * MiB, 2), "webapp/2026/10/01/app.log.gz": obj(640_000, 1) } },
      "acme-finance-reports": { created: now - 500 * day, region: "us-east-1", denied: true, objects: { "2026/q3-revenue.xlsx": obj(88_000, 5) } },
    },
    instances: [
      inst("i-0a1b2c3d4e5f60001", "web-1", "t3.small", "running", "10.0.1.23", "203.0.113.10", "production"),
      inst("i-0a1b2c3d4e5f60002", "web-2", "t3.small", "running", "10.0.1.50", "203.0.113.11", "production"),
      inst("i-0a1b2c3d4e5f60003", "db-1", "r6i.large", "running", "10.0.2.15", null, "production"),
      inst("i-0a1b2c3d4e5f60004", "bastion", "t3.micro", "stopped", "10.0.0.5", "203.0.113.12", "production"),
      inst("i-0a1b2c3d4e5f60005", "batch-worker", "c6i.xlarge", "stopped", "10.0.3.40", null, "staging"),
    ],
    logGroups: {
      "/acme/webapp": [
        { stream: "web-1", t: now - 3 * 3600_000, msg: "INFO  [http] GET /api/products 200 31ms" },
        { stream: "web-1", t: now - 2 * 3600_000, msg: "ERROR [checkout] PaymentGatewayTimeout: payment provider did not respond within 5000ms" },
        { stream: "web-2", t: now - 90 * 60_000, msg: "WARN  [db] slow query took 1840ms" },
        { stream: "web-1", t: now - 40 * 60_000, msg: "ERROR [checkout] DatabaseError: connection reset by peer (db.internal:5432)" },
        { stream: "web-2", t: now - 10 * 60_000, msg: "INFO  [http] POST /api/cart 200 18ms" },
      ],
      "/acme/nginx/access": [{ stream: "web-1", t: now - 30 * 60_000, msg: '203.0.113.77 - - "GET /products/42 HTTP/1.1" 200 5123' }],
      "/aws/lambda/image-resizer": [
        { stream: "2026/10/02/[$LATEST]a1b2", t: now - 5 * 3600_000, msg: "START RequestId: 1f2e3d4c Version: $LATEST" },
        { stream: "2026/10/02/[$LATEST]a1b2", t: now - 5 * 3600_000 + 900, msg: "Task timed out after 3.00 seconds" },
      ],
    },
    iam: {
      users: [
        { UserName: "alice", created: now - 700 * day, policies: ["AdministratorAccess"], groups: ["admins"] },
        { UserName: "bob", created: now - 200 * day, policies: ["ReadOnlyAccess"], groups: ["developers"] },
        { UserName: "ci-deployer", created: now - 150 * day, policies: ["AmazonS3FullAccess"], groups: [] },
      ],
      roles: [
        { RoleName: "webapp-ec2-role", created: now - 400 * day, policies: ["AmazonS3ReadOnlyAccess", "CloudWatchAgentServerPolicy"], trust: "ec2.amazonaws.com" },
        { RoleName: "image-resizer-lambda-role", created: now - 100 * day, policies: ["AWSLambdaBasicExecutionRole"], trust: "lambda.amazonaws.com" },
      ],
    },
  };
};

function units(): Record<string, Unit> {
  const u = (description: string, user: string, exec: string, ports: number[], mem: number, cpu: number, unitFile: string, extra: Partial<Unit> = {}): Unit => ({
    description, user, exec, ports, mem, cpu, unitFile, enabled: true, active: true, failed: false, since: 0, checks: [], ...extra,
  });
  return {
    ssh: u("OpenBSD Secure Shell server", "root", "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups", [22], 0.4, 0, "/usr/lib/systemd/system/ssh.service"),
    cron: u("Regular background program processing daemon", "root", "/usr/sbin/cron -f -P", [], 0.1, 0, "/usr/lib/systemd/system/cron.service"),
    rsyslog: u("System Logging Service", "syslog", "/usr/sbin/rsyslogd -n -iNONE", [], 0.3, 0, "/usr/lib/systemd/system/rsyslog.service"),
    nginx: u("A high performance web server and a reverse proxy server", "root", "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;", [80], 0.1, 0, "/usr/lib/systemd/system/nginx.service", {
      workers: { user: "www-data", cmd: "nginx: worker process", count: 2 },
      checks: [{ type: "nginx-config" }, { type: "port-free" }],
    }),
    webapp: u("Acme Store web application", "webapp", "/usr/bin/node /opt/webapp/server.js", [3000], 4.6, 1.2, "/etc/systemd/system/webapp.service", {
      checks: [{ type: "file-exists", path: "/opt/webapp/server.js" }, { type: "file-readable", path: "/etc/webapp/webapp.env" }, { type: "port-free" }, { type: "disk-space" }],
    }),
    "amazon-ssm-agent": u("amazon-ssm-agent", "root", "/snap/amazon-ssm-agent/9881/amazon-ssm-agent", [], 1.1, 0.1, "/etc/systemd/system/snap.amazon-ssm-agent.amazon-ssm-agent.service"),
    "systemd-journald": u("Journal Service", "root", "/usr/lib/systemd/systemd-journald", [], 0.8, 0, "/usr/lib/systemd/system/systemd-journald.service"),
    "systemd-resolved": u("Network Name Resolution", "systemd-resolve", "/usr/lib/systemd/systemd-resolved", [53], 0.6, 0, "/usr/lib/systemd/system/systemd-resolved.service"),
    "systemd-logind": u("User Login Management", "root", "/usr/lib/systemd/systemd-logind", [], 0.4, 0, "/usr/lib/systemd/system/systemd-logind.service"),
  };
}

const DEVICES = (): Device[] => [
  { name: "nvme0n1", size: 8 * GiB, type: "disk" },
  { name: "nvme0n1p1", size: 7.9 * GiB, type: "part", parent: "nvme0n1", fstype: "ext4", label: "cloudimg-rootfs", uuid: "4c9a3f2e-7d1b-4b8e-9f2a-1e6c5d8b7a90", mountpoint: "/" },
  { name: "nvme0n1p14", size: 4 * MiB, type: "part", parent: "nvme0n1" },
  { name: "nvme0n1p15", size: 106 * MiB, type: "part", parent: "nvme0n1", fstype: "vfat", label: "UEFI", uuid: "B1C4-2E7F", mountpoint: "/boot/efi" },
  { name: "nvme1n1", size: 20 * GiB, type: "disk" },
];

export async function createBaseState(): Promise<LabState> {
  const now = Date.now();
  const boot = now - (3 * 86400 + 4 * 3600 + 12 * 60) * 1000;
  const fs = new LabFs(new InMemoryFs(), { owners: {}, sizes: {}, links: {}, nextLink: 1 });

  for (const [dir, mode, owner] of DIRS) {
    await fs.mkdir(dir, { recursive: true });
    if (mode) await fs.chmod(dir, mode);
    if (owner) fs.setOwner(dir, owner);
  }
  await fs.symlink("usr/bin", "/bin");
  await fs.symlink("usr/sbin", "/sbin");
  for (const dev of ["null", "zero", "random", "urandom"]) {
    await fs.inner.writeFile(`/dev/${dev}`, "");
    await fs.inner.chmod(`/dev/${dev}`, 0o666);
  }

  const shadowUser = (name: string, hash = "!") => `${name}:${hash}:19950:0:99999:7:::`;
  const files: Spec[] = [
    ["/etc/hostname", `${HOSTNAME}\n`],
    ["/etc/hosts", "127.0.0.1 localhost\n\n# The following lines are desirable for IPv6 capable hosts\n::1 ip6-localhost ip6-loopback\nfe00::0 ip6-localnet\nff00::0 ip6-mcastprefix\nff02::1 ip6-allnodes\nff02::2 ip6-allrouters\n"],
    ["/etc/os-release", 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\nVERSION_CODENAME=noble\nID=ubuntu\nID_LIKE=debian\nHOME_URL="https://www.ubuntu.com/"\n'],
    ["/etc/timezone", "Etc/UTC\n"],
    ["/etc/resolv.conf", "# This is /run/systemd/resolve/stub-resolv.conf managed by man:systemd-resolved(8).\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch ec2.internal\n"],
    ["/etc/fstab", "LABEL=cloudimg-rootfs\t/\text4\tdiscard,commit=30,errors=remount-ro\t0 1\nLABEL=UEFI\t/boot/efi\tvfat\tumask=0077\t0 1\n"],
    ["/etc/environment", 'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"\n'],
    [
      "/etc/passwd",
      [
        "root:x:0:0:root:/root:/bin/bash", "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin", "bin:x:2:2:bin:/bin:/usr/sbin/nologin",
        "sys:x:3:3:sys:/dev:/usr/sbin/nologin", "www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin", "syslog:x:102:102::/nonexistent:/usr/sbin/nologin",
        "sshd:x:105:65534::/run/sshd:/usr/sbin/nologin", "systemd-resolve:x:996:996:systemd Resolver:/:/usr/sbin/nologin", "webapp:x:997:997:Acme web application:/opt/webapp:/usr/sbin/nologin",
        "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin", "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash",
        "student:x:1001:1001:Student:/home/student:/bin/bash", "deploy:x:1002:1002:Deploy user:/home/deploy:/bin/bash",
      ].join("\n") + "\n",
    ],
    [
      "/etc/group",
      [
        "root:x:0:", "daemon:x:1:", "bin:x:2:", "sys:x:3:", "adm:x:4:syslog,ubuntu,student", "tty:x:5:", "sudo:x:27:ubuntu,student",
        "www-data:x:33:", "shadow:x:42:", "users:x:100:", "crontab:x:101:", "syslog:x:102:", "systemd-resolve:x:996:", "webapp:x:997:",
        "nogroup:x:65534:", "ubuntu:x:1000:", "student:x:1001:", "deploy:x:1002:", "developers:x:1003:deploy",
      ].join("\n") + "\n",
    ],
    ["/etc/shadow", ["root:*:19950:0:99999:7:::", ...["daemon", "bin", "sys", "www-data", "syslog", "sshd", "systemd-resolve", "webapp", "nobody"].map((u) => shadowUser(u, "*")), shadowUser("ubuntu"), shadowUser("student"), shadowUser("deploy", "$6$rounds=4096$Ab3dEf$Qm9ZqZ5vP1xYwz0hN3cR7tL2kU8sJ4fG6dH1aB5eC9iO0pX3vM7nK2lT8wQ4rS6yU1zE5gF9jH3kL7mN0bV2cX")].join("\n") + "\n", 0o640, ["root", "shadow"]],
    ["/etc/sudoers", "Defaults\tenv_reset\nDefaults\tsecure_path=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"\n\nroot\tALL=(ALL:ALL) ALL\n%sudo\tALL=(ALL:ALL) ALL\n\n@includedir /etc/sudoers.d\n", 0o440],
    ["/etc/sudoers.d/90-cloud-init-users", "# Created by cloud-init\nubuntu ALL=(ALL) NOPASSWD:ALL\nstudent ALL=(ALL) NOPASSWD:ALL\n", 0o440],
    ["/etc/skel/.bashrc", BASHRC],
    ["/etc/skel/.profile", PROFILE],
    ["/etc/ssh/sshd_config", "Include /etc/ssh/sshd_config.d/*.conf\n\nPort 22\nPermitRootLogin prohibit-password\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM yes\nX11Forwarding no\nPrintMotd no\nAcceptEnv LANG LC_*\nSubsystem sftp /usr/lib/openssh/sftp-server\n"],
    ["/etc/ssh/ssh_config", "Host *\n    SendEnv LANG LC_*\n    HashKnownHosts yes\n"],
    ["/etc/nginx/nginx.conf", NGINX_CONF],
    ["/etc/nginx/mime.types", "types {\n    text/html html htm;\n    text/css css;\n    application/javascript js;\n    image/png png;\n}\n"],
    ["/etc/nginx/sites-available/default", NGINX_SITE],
    ["/etc/webapp/webapp.env", "NODE_ENV=production\nPORT=3000\nDATABASE_URL=postgres://webapp:change-me@db.internal:5432/acme\nLOG_LEVEL=info\n", 0o640, ["root", "webapp"]],
    ["/etc/systemd/system/webapp.service", unitFile("Acme Store web application", "webapp", "/usr/bin/node /opt/webapp/server.js", "EnvironmentFile=/etc/webapp/webapp.env\nWorkingDirectory=/opt/webapp\n")],
    ["/usr/lib/systemd/system/nginx.service", "[Unit]\nDescription=A high performance web server and a reverse proxy server\nAfter=network-online.target\n\n[Service]\nType=forking\nPIDFile=/run/nginx.pid\nExecStartPre=/usr/sbin/nginx -t -q -g 'daemon on; master_process on;'\nExecStart=/usr/sbin/nginx -g 'daemon on; master_process on;'\nExecReload=/usr/sbin/nginx -g 'daemon on; master_process on;' -s reload\n\n[Install]\nWantedBy=multi-user.target\n"],
    ["/usr/lib/systemd/system/ssh.service", unitFile("OpenBSD Secure Shell server", "root", "/usr/sbin/sshd -D")],
    ["/usr/lib/systemd/system/cron.service", unitFile("Regular background program processing daemon", "root", "/usr/sbin/cron -f -P")],
    ["/etc/crontab", "SHELL=/bin/sh\n# m h dom mon dow user\tcommand\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n25 6\t* * *\troot\ttest -x /usr/sbin/anacron || { cd / && run-parts --report /etc/cron.daily; }\n"],
    ["/etc/cron.d/webapp-cleanup", "# Remove webapp logs older than 14 days\n0 3 * * * root find /var/log/webapp -name '*.log.*' -mtime +14 -delete\n"],
    ["/etc/logrotate.d/nginx", "/var/log/nginx/*.log {\n\tdaily\n\tmissingok\n\trotate 14\n\tcompress\n\tdelaycompress\n\tnotifempty\n\tcreate 0640 www-data adm\n}\n"],
    ["/opt/webapp/server.js", SERVER_JS, 0o644, ["webapp", "webapp"]],
    ["/opt/webapp/package.json", '{\n  "name": "acme-store",\n  "version": "2.4.1",\n  "main": "server.js"\n}\n', 0o644, ["webapp", "webapp"]],
    ["/var/www/html/index.html", INDEX_HTML],
    ["/run/nginx.pid", "812\n"],
    ["/root/.bashrc", BASHRC],
    ["/home/student/.bashrc", BASHRC],
    ["/home/student/.profile", PROFILE],
    ["/home/student/.ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq3n8Yp0dZr2u4x6w8y0aB2c4e6g8i0k2m4o6q8s0u2 student@laptop\n", 0o600],
    ["/home/student/.aws/config", "[default]\nregion = us-east-1\noutput = json\n"],
    ["/home/ubuntu/.bashrc", BASHRC],
    ["/home/ubuntu/.ssh/authorized_keys", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB7x9w1v3t5r7p9n1l3j5h7f9d1b3z5x7v9t1r3p5n7l acme-prod\n", 0o600],
    ["/home/deploy/.bashrc", BASHRC],
    ["/var/log/nginx/access.log", accessLog(now), 0o640, ["www-data", "adm"]],
    [
      "/var/log/nginx/error.log",
      `${new Date(now - 7 * 3600_000).toISOString().slice(0, 19).replace("T", " ").replace(/-/g, "/")} [error] 813#813: *1453 connect() failed (111: Connection refused) while connecting to upstream, client: 198.51.100.23, server: _, request: "GET /api/cart HTTP/1.1", upstream: "http://127.0.0.1:3000/cart", host: "acme.example"\n`,
      0o640,
      ["www-data", "adm"],
    ],
    ["/var/log/webapp/app.log", appLog(now), 0o644, ["webapp", "webapp"]],
    ["/var/log/auth.log", authLog(now), 0o640, ["syslog", "adm"]],
    ["/var/log/syslog", syslog(now, boot), 0o640, ["syslog", "adm"]],
    ["/var/log/cloud-init-output.log", `Cloud-init v. 24.1.3-0ubuntu3 running 'modules:final' at ${new Date(boot).toUTCString()}.\nCloud-init v. 24.1.3-0ubuntu3 finished. Datasource DataSourceEc2Local. Up 18.42 seconds\n`],
    ["/var/log/apt/history.log", "Start-Date: 2026-09-01  10:02:11\nCommandline: apt-get install -y nginx nodejs\nInstall: nginx:amd64 (1.24.0-2ubuntu7), nodejs:amd64 (18.19.1+dfsg-6ubuntu5)\nEnd-Date: 2026-09-01  10:02:40\n"],
    ["/home/student/logs/app.log", appLog(now).split("\n").slice(0, 60).join("\n") + "\n"],
    ["/proc/cpuinfo", ["processor\t: 0", "vendor_id\t: GenuineIntel", "model name\t: Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz", "cpu MHz\t\t: 2499.998", "cpu cores\t: 1", "", "processor\t: 1", "vendor_id\t: GenuineIntel", "model name\t: Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz", "cpu MHz\t\t: 2499.998", "cpu cores\t: 1", ""].join("\n"), 0o444],
    ["/proc/meminfo", `MemTotal:        ${MEM_TOTAL_KB} kB\nMemFree:          612340 kB\nMemAvailable:    1402112 kB\nBuffers:           41236 kB\nCached:           702188 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\n`, 0o444],
    ["/proc/version", "Linux version 6.8.0-1012-aws (buildd@lcy02-amd64-012) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0) #13-Ubuntu SMP\n", 0o444],
    ...PRACTICE,
  ];
  for (const [path, content, mode, owner] of files) {
    await fs.writeFile(path, content);
    if (mode) await fs.chmod(path, mode);
    if (owner) fs.setOwner(path, owner);
  }
  await fs.symlink("/etc/nginx/sites-available/default", "/etc/nginx/sites-enabled/default");
  await fs.writeFile("/home/student/.bash_history", "");
  for (const p of fs.getAllPaths()) if (p.startsWith("/home/student/") || p === "/home/student") fs.setOwner(p, ["student", "student"]);
  for (const p of fs.getAllPaths()) if (p.startsWith("/root") || /^\/(etc|var|usr|opt|srv|proc)\//.test(p)) await fs.inner.utimes(p, new Date(boot), new Date(boot));
  for (const p of ["/var/log/nginx/access.log", "/var/log/webapp/app.log", "/var/log/auth.log", "/var/log/syslog"]) await fs.inner.utimes(p, new Date(now - 60_000), new Date(now - 60_000));

  const state: LabState = {
    v: 1,
    fs: await fs.snapshot(() => false),
    env: {
      HOME: "/home/student", USER: LOGIN, LOGNAME: LOGIN, SHELL: "/bin/bash", HOSTNAME,
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin",
      PWD: "/home/student", LANG: "C.UTF-8", TERM: "xterm-256color", EDITOR: "nano",
      BASH_ALIAS_ll: "ls -alF", BASH_ALIAS_la: "ls -A", BASH_ALIAS_l: "ls -CF",
    },
    procs: [],
    nextPid: 2400,
    jobs: [],
    nextJob: 1,
    units: units(),
    journal: [],
    devices: DEVICES(),
    history: [],
    bootTime: boot,
    locateDb: [],
    aws: AWS(),
  };

  const sys = (pid: number, ppid: number, user: string, cmd: string, cpu: number, mem: number, at: number, extra: Partial<Proc> = {}): Proc => ({
    pid, ppid, user, cmd, cpu, mem, rss: Math.round((MEM_TOTAL_KB * mem) / 100), vsz: Math.max(8000, Math.round((MEM_TOTAL_KB * mem) / 30)), stat: "Ss", start: boot + at, tty: "?", ...extra,
  });
  state.procs.push(
    sys(1, 0, "root", "/sbin/init", 0.1, 0.6, 0, { unit: "systemd" }),
    sys(2, 0, "root", "[kthreadd]", 0, 0, 0, { rss: 0, vsz: 0, stat: "S" }),
    sys(15, 2, "root", "[ksoftirqd/0]", 0, 0, 0, { rss: 0, vsz: 0, stat: "S" }),
    sys(312, 1, "root", "/usr/lib/systemd/systemd-journald", 0, 0.8, 2000, { unit: "systemd-journald" }),
    sys(360, 1, "systemd-resolve", "/usr/lib/systemd/systemd-resolved", 0, 0.6, 2500, { unit: "systemd-resolved", ports: [53] }),
    sys(402, 1, "root", "/usr/sbin/cron -f -P", 0, 0.1, 3000, { unit: "cron" }),
    sys(405, 1, "syslog", "/usr/sbin/rsyslogd -n -iNONE", 0, 0.3, 3000, { unit: "rsyslog", stat: "Ssl" }),
    sys(410, 1, "root", "/snap/amazon-ssm-agent/9881/amazon-ssm-agent", 0.1, 1.1, 3100, { unit: "amazon-ssm-agent", stat: "Ssl" }),
    sys(418, 1, "root", "/usr/lib/systemd/systemd-logind", 0, 0.4, 3100, { unit: "systemd-logind" }),
    sys(690, 1, "root", "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups", 0, 0.4, 4000, { unit: "ssh", ports: [22] }),
    sys(812, 1, "root", "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;", 0, 0.1, 4500, { unit: "nginx", ports: [80] }),
    sys(813, 812, "www-data", "nginx: worker process", 0, 0.3, 4500, { unit: "nginx", stat: "S" }),
    sys(814, 812, "www-data", "nginx: worker process", 0, 0.3, 4500, { unit: "nginx", stat: "S" }),
    sys(901, 1, "webapp", "/usr/bin/node /opt/webapp/server.js", 1.2, 4.6, 5000, { unit: "webapp", ports: [3000], stat: "Ssl" }),
    sys(1820, 690, "root", "sshd: student [priv]", 0, 0.5, now - boot - 3 * 3600_000, { stat: "Ss" }),
    sys(1902, 1820, "student", "sshd: student@pts/0", 0, 0.3, now - boot - 3 * 3600_000, { stat: "S" }),
    sys(SHELL_PID, 1902, "student", "-bash", 0, 0.3, now - boot - 3 * 3600_000, { tty: "pts/0", stat: "Ss" }),
  );
  for (const [name, unit] of Object.entries(state.units)) {
    unit.since = boot + 4000;
    unit.mainPid = state.procs.find((p) => p.unit === name && p.ppid === 1)?.pid;
    journal(state, name, "systemd", 1, `Started ${name}.service - ${unit.description}.`, 6, boot + 4000);
  }
  journal(state, "webapp", "node", 901, "webapp listening on port 3000", 6, boot + 5200);
  journal(state, "nginx", "systemd", 1, "nginx.service: Reloading.", 6, now - 26 * 3600_000);
  journal(state, "ssh", "sshd", 690, "Server listening on 0.0.0.0 port 22.", 6, boot + 4100);
  journal(state, "webapp", "node", 901, "PaymentGatewayTimeout: payment provider did not respond within 5000ms", 3, now - 2 * 3600_000);
  state.locateDb = fs.getAllPaths().filter((p) => !p.startsWith("/proc"));
  return state;
}
