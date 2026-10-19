export interface ScrollPosition {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export class ScrollFollow {
  private following = true;
  private previousTop = 0;
  private direction = 0;
  private dragging = false;

  reset(position: ScrollPosition) {
    this.following = true;
    this.direction = 0;
    this.dragging = false;
    this.follow(position);
  }

  userIntent(direction: number, position: ScrollPosition) {
    this.direction = Math.sign(direction);
    if (this.direction < 0) this.following = false;
    if (
      this.direction > 0 &&
      position.scrollHeight - position.scrollTop - position.clientHeight <= 2
    )
      this.following = true;
  }

  beginDrag() {
    this.dragging = true;
    this.following = false;
  }

  endDrag() {
    this.dragging = false;
  }

  endGesture() {
    this.direction = 0;
    this.dragging = false;
  }

  scrolled(position: ScrollPosition) {
    const movement = position.scrollTop - this.previousTop;
    if (this.dragging || this.direction !== 0) {
      if (movement < 0) this.following = false;
      if (
        movement > 0 &&
        (this.dragging || this.direction > 0) &&
        position.scrollHeight - position.scrollTop - position.clientHeight <= 2
      )
        this.following = true;
    }
    this.previousTop = position.scrollTop;
  }

  layoutChanged(position: ScrollPosition) {
    // Layout and browser anchoring cannot resume a paused user gesture.
    this.direction = 0;
    this.follow(position);
  }

  private follow(position: ScrollPosition) {
    if (this.following)
      position.scrollTop = Math.max(0, position.scrollHeight - position.clientHeight);
    this.previousTop = position.scrollTop;
  }
}
