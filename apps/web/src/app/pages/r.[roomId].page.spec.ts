import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { createRoomId } from '@duplex/protocol';
import RoomPage from './r.[roomId].page';

async function render(roomId: string): Promise<HTMLElement> {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(RoomPage);
  fixture.componentRef.setInput('roomId', roomId);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('RoomPage', () => {
  it('shows the truthful joining shell for a valid room id', async () => {
    const element = await render(createRoomId());
    expect(element.querySelector('h1')?.textContent).toContain('Joining Duplex room');
    expect(element.textContent).toContain('nobody is connected');
  });

  it('rejects ids that are not Duplex room ids', async () => {
    const element = await render('1');
    expect(element.querySelector('h1')?.textContent).toContain('Invalid room link');
  });
});
