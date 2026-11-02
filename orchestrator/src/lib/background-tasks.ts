export class BackgroundTasks {
  private tasks: Array<() => void | Promise<void>> = [];

  add(task: () => void | Promise<void>): void {
    this.tasks.push(task);
  }

  run(): void {
    for (const task of this.tasks) {
      void Promise.resolve()
        .then(task)
        .catch((err) => console.error("background task failed", err));
    }
    this.tasks = [];
  }
}
