declare module 'bun:sqlite' {
  export class Database {
    constructor(filename?: string);
    run(sql: string): void;
    query(sql: string): {
      get(...params: any[]): any;
      all(...params: any[]): any[];
    };
    prepare(sql: string): {
      run(...params: any[]): void;
      get(...params: any[]): any;
      all(...params: any[]): any[];
    };
    close(): void;
  }
}
