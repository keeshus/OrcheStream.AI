import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Icon } from '@/components/ui/Icon';

describe('Icon', () => {
  it('renders with correct icon name', () => {
    render(<Icon name="check_circle" />);
    const el = screen.getByText('check_circle');
    expect(el).toBeInTheDocument();
  });

  it('has material-symbols-outlined class', () => {
    render(<Icon name="close" />);
    const el = screen.getByText('close');
    expect(el.className).toContain('material-symbols-outlined');
  });

  it('applies additional className', () => {
    render(<Icon name="search" className="text-xl" />);
    const el = screen.getByText('search');
    expect(el.className).toContain('text-xl');
  });

  it('sets fontSize from size prop', () => {
    render(<Icon name="home" size={32} />);
    const el = screen.getByText('home');
    expect(el.style.fontSize).toBe('32px');
  });

  it('sets fontVariationSettings for fill, weight, grade', () => {
    render(<Icon name="star" weight={400} grade={200} fill />);
    const el = screen.getByText('star');
    expect(el.getAttribute('style')).toContain('FILL');
    expect(el.getAttribute('style')).toContain('wght');
    expect(el.getAttribute('style')).toContain('GRAD');
  });

  it('handles empty string name', () => {
    const { container } = render(<Icon name="" />);
    const el = container.querySelector('.material-symbols-outlined');
    expect(el).toBeInTheDocument();
  });

  it('sets FILL to 0 when fill is false', () => {
    render(<Icon name="star" fill={false} />);
    const el = screen.getByText('star');
    expect(el.style.fontVariationSettings).toContain("'FILL' 0");
  });

  it('sets fontVariationSettings for weight only', () => {
    render(<Icon name="star" weight={500} />);
    const el = screen.getByText('star');
    expect(el.style.fontVariationSettings).toContain('wght');
    expect(el.style.fontVariationSettings).not.toContain('FILL');
    expect(el.style.fontVariationSettings).not.toContain('GRAD');
  });

  it('sets fontVariationSettings for grade only', () => {
    render(<Icon name="star" grade={200} />);
    const el = screen.getByText('star');
    expect(el.style.fontVariationSettings).toContain('GRAD');
    expect(el.style.fontVariationSettings).not.toContain('FILL');
    expect(el.style.fontVariationSettings).not.toContain('wght');
  });
});