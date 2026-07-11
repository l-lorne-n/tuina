(function () {
  const page = document.body.dataset.toolPage || "";
  const params = new URLSearchParams(window.location.search);
  const patientId = params.get("patientId") || "";
  const returnTo = `${window.location.pathname}${window.location.search}`;

  const entryHref = page === "patient-sessions" && patientId ? `/?patientId=${encodeURIComponent(patientId)}` : "/";
  const signatureHref =
    page === "patient-sessions" && patientId
      ? `/signature-pad.html?patientId=${encodeURIComponent(patientId)}&kind=visit&returnTo=${encodeURIComponent(
          returnTo
        )}`
      : "/signature-pad.html";

  const groups = [
    {
      title: "后端服务管理",
      links: [
        {
          id: "entry",
          label: "录入页",
          href: entryHref,
          note: page === "patient-sessions" && patientId ? "当前患者完整记录" : "基础资料录入",
        },
        {
          id: "signature-pad",
          label: "电子签名",
          href: signatureHref,
          note: page === "patient-sessions" && patientId ? "当前患者签名" : "签名画板",
        },
        { id: "backup", label: "云备份", href: "/backup.html", note: "增量加密备份" },
        { id: "adjustment-reversal", label: "冲正流水", href: "/adjustment-reversal.html", note: "撤销加减次数" },
        { id: "bulk-sign", label: "批量补签", href: "/bulk-sign.html", note: "老板补签确认" },
        { id: "settlements", label: "月结", href: "/settlements.html", note: "区间结算存档" },
      ],
    },
    {
      title: "小工具",
      links: [
        { id: "signature-review", label: "签名核对", href: "/signature-review.html", note: "目录签名绑定" },
        { id: "signature-test", label: "签名测试", href: "/signature-test.html", note: "不写入真实患者" },
      ],
    },
  ];

  const dock = document.createElement("aside");
  dock.className = "tool-dock";
  dock.setAttribute("aria-label", "工具栏");
  dock.innerHTML = `
    <button class="tool-dock-toggle" type="button" aria-expanded="false">工具栏</button>
    <div class="tool-dock-panel" role="dialog" aria-label="工具栏">
      <div class="tool-dock-head">
        <div class="tool-dock-title">工具栏</div>
        <button class="tool-dock-close" type="button" aria-label="关闭工具栏">×</button>
      </div>
      ${groups
        .map(
          (group) => `
            <div class="tool-group">
              <div class="tool-group-title">${escapeHtml(group.title)}</div>
              ${group.links
                .map(
                  (link) => `
                    <a class="tool-link${link.id === page ? " active" : ""}" href="${link.href}">
                      <strong>${escapeHtml(link.label)}</strong>
                      <span>${escapeHtml(link.note)}</span>
                    </a>
                  `
                )
                .join("")}
            </div>
          `
        )
        .join("")}
    </div>
  `;

  const toggle = dock.querySelector(".tool-dock-toggle");
  const closeButton = dock.querySelector(".tool-dock-close");

  function setOpen(open) {
    dock.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  toggle.addEventListener("click", () => setOpen(!dock.classList.contains("open")));
  closeButton.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (!dock.contains(event.target)) setOpen(false);
  });

  document.body.appendChild(dock);

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
