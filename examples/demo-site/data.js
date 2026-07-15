/** Shared localStorage store for the demo task list. */
const DemoStore = (() => {
  const KEY = "bb-demo-tasks"

  const seed = () => [
    { id: "1", title: "Inbox zero", body: "Clear the backlog before noon." },
    { id: "2", title: "Ship release notes", body: "Draft and publish v0.2 notes." },
    { id: "3", title: "Call design review", body: "Book 30m with the design team." },
    { id: "4", title: "Fix flaky test", body: "Stabilize the CI snapshot test." },
    { id: "5", title: "Update docs", body: "Document the automation runner." },
  ]

  function read() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "null")
    } catch {
      return null
    }
  }

  function write(items) {
    localStorage.setItem(KEY, JSON.stringify(items))
  }

  return {
    ensure() {
      if (!read()) write(seed())
    },
    reset() {
      write(seed())
    },
    list() {
      this.ensure()
      return read() || []
    },
    get(id) {
      return this.list().find((x) => String(x.id) === String(id)) || null
    },
    remove(id) {
      write(this.list().filter((x) => String(x.id) !== String(id)))
    },
  }
})()
