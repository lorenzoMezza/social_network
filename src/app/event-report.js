// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { ReportEventScreen } from '../features/events/screens/ReportEventScreen';

export default function EventReportRoute() {
  const { id } = useLocalSearchParams();
  return <ReportEventScreen key={id} id={id} />;
}
