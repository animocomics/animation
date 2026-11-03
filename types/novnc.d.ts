declare module "@novnc/novnc" {
  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | object, options?: { shared?: boolean });
    scaleViewport: boolean;
    clipViewport: boolean;
    showDotCursor: boolean;
    disconnect(): void;
    addEventListener(type: "connect" | "disconnect" | "securityfailure", listener: () => void): void;
  }
}
